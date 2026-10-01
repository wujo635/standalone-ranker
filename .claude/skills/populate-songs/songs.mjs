#!/usr/bin/env node
// Helper for the populate-songs skill. Talks to MusicBrainz (1 req/s, no key) and
// writes standalone-ranker preload CSVs. Every command prints compact JSON or text
// so the skill doesn't have to wade through raw API responses.
//
//   node songs.mjs artist "<name>"            candidate artists (id, name, country, disambiguation)
//   node songs.mjs albums <artistId>          release groups: albums, EPs, singles (no live/compilation/remix)
//   node songs.mjs editions <releaseGroupId>  official releases of one album, with track counts
//   node songs.mjs tracks <releaseId>         track list (+ language, date) of one release
//   node songs.mjs genre "<Wikipedia title>"  genres from the page's infobox
//   node songs.mjs csv <rows.json> <out.csv>  write a preload CSV from [{Title, Artist, ...}]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const UA = 'standalone-ranker-populate-songs/1.0 ( https://github.com/wujo635/standalone-ranker )';
const MB = 'https://musicbrainz.org/ws/2/';
const FIELDS = ['Artist', 'Album', 'Year', 'Language', 'Genre']; // Songs schema, after primary 'Title'
const LANGS = { eng: 'English', jpn: 'Japanese', kor: 'Korean', zho: 'Chinese', spa: 'Spanish',
  fra: 'French', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian', hin: 'Hindi',
  tha: 'Thai', vie: 'Vietnamese', tgl: 'Tagalog', ind: 'Indonesian', swe: 'Swedish', nld: 'Dutch',
  ara: 'Arabic', tur: 'Turkish', pol: 'Polish', heb: 'Hebrew', mul: 'Multiple' };

let lastCall = 0;
async function mb(path) {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(MB + path + (path.includes('?') ? '&' : '?') + 'fmt=json', { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${path}`);
  return res.json();
}

const year = d => (d || '').slice(0, 4);

const commands = {
  async artist(name) {
    const j = await mb('artist/?limit=5&query=' + encodeURIComponent(`artist:"${name}"`));
    return j.artists.map(a => ({ id: a.id, name: a.name, type: a.type, country: a.country,
      disambiguation: a.disambiguation || '', score: a.score }));
  },

  async albums(artistId) {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const j = await mb(`release-group?artist=${artistId}&type=album|ep|single&limit=100&offset=${offset}`);
      for (const g of j['release-groups']) {
        // secondary types = Live, Compilation, Remix, Demo, Soundtrack... — not original releases
        if ((g['secondary-types'] || []).length) continue;
        out.push({ type: g['primary-type'], date: g['first-release-date'], title: g.title, id: g.id });
      }
      if (offset + 100 >= j['release-group-count']) break;
    }
    const order = { Album: 0, EP: 1, Single: 2 };
    return out.sort((a, b) => order[a.type] - order[b.type] || (a.date || '').localeCompare(b.date || ''));
  },

  async editions(rgId) {
    const j = await mb(`release?release-group=${rgId}&inc=media&status=official&limit=100`);
    return j.releases
      .map(r => ({ id: r.id, date: r.date || '', country: r.country || '', edition: r.disambiguation || '',
        media: r.media.map(m => `${m.format || '?'}:${m['track-count']}`).join('+'),
        tracks: r.media.reduce((n, m) => n + m['track-count'], 0) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.tracks - b.tracks);
  },

  async tracks(releaseId) {
    const r = await mb(`release/${releaseId}?inc=recordings+artist-credits+release-groups`);
    const lang = r['text-representation']?.language;
    const credit = ac => (ac || []).map(c => c.name + (c.joinphrase || '')).join('');
    return {
      album: r['release-group']?.title || r.title,
      edition: r.disambiguation || '',
      year: year(r['release-group']?.['first-release-date'] || r.date),
      language: LANGS[lang] || lang || '',
      albumArtist: credit(r['artist-credit']),
      tracks: r.media.flatMap((m, d) => m.tracks.map(t => ({
        disc: d + 1, n: t.position, title: t.title,
        artist: credit(t['artist-credit']), length: t.length ? Math.round(t.length / 1000) : null,
        recording: t.recording?.disambiguation || ''
      })))
    };
  },

  async genre(title) {
    const res = await fetch(`https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`,
      { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Wikipedia ${res.status} for ${title}`);
    const text = await res.text();
    if (/^#REDIRECT/i.test(text)) return { redirect: text.match(/\[\[([^\]]+)\]\]/)?.[1] };
    const m = text.match(/\|\s*genre\s*=([\s\S]*?)\n\s*\|\s*[a-z_ ]+=/i);
    if (!m) return { genres: [] };
    const genres = [...m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '')
      .matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)]
      .map(g => (g[2] || g[1]).trim())
      .map(g => g.charAt(0).toUpperCase() + g.slice(1));
    return { genres: [...new Set(genres)] };
  },

  csv(rowsPath, outPath) {
    const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
    // The app's splitCSVLine() toggles on every `"` and has no `""` escape, so a literal
    // double quote in a value would corrupt the row — swap it for a typographic one.
    // Curly apostrophes and Unicode hyphens (MusicBrainz style) become ASCII, so a title
    // matches what a user would type — the title is part of the item id.
    const cell = v => {
      const s = String(v ?? '').replace(/[‘’]/g, "'").replace(/[‐‑]/g, '-').replace(/"/g, '”').replace(/[\r\n]+/g, ' ').trim();
      return /,/.test(s) ? `"${s}"` : s;
    };
    const missing = rows.filter(r => !r.Title || !r.Artist);
    if (missing.length) throw new Error(`${missing.length} row(s) missing Title or Artist`);
    const lines = [
      '#category,Songs',
      '#primary,Title',
      ...FIELDS.map(f => `#field,${f},${f === 'Artist' ? 'required' : 'optional'}`),
      ['Title', ...FIELDS].join(','),
      ...rows.map(r => ['Title', ...FIELDS].map(f => cell(r[f])).join(','))
    ];
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
    return `Wrote ${rows.length} songs to ${outPath}`;
  }
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.error('Usage: node songs.mjs artist|albums|editions|tracks|genre|csv ...');
  process.exit(1);
}
try {
  const out = await commands[cmd](...args);
  // One record per line: readable, and much shorter than fully indented JSON.
  const fmt = v => Array.isArray(v) ? '[\n' + v.map(x => ' ' + JSON.stringify(x)).join(',\n') + '\n]'
    : v && typeof v === 'object' ? '{\n' + Object.entries(v).map(([k, x]) => ` "${k}": ${fmt(x)}`).join(',\n') + '\n}'
    : JSON.stringify(v);
  console.log(typeof out === 'string' ? out : fmt(out));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

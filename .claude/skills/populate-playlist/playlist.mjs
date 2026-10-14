#!/usr/bin/env node
// Helper for the populate-playlist skill: reads a public Spotify playlist and looks each
// track's recording up in MusicBrainz by ISRC. Every command prints compact JSON.
//
//   node playlist.mjs playlist "<playlist link | spotify:playlist:… | id>"
//       name, owner and every track: title, artists, Spotify's album, release date, ISRC.
//       Local files, podcast episodes and unavailable tracks are listed under `skipped`.
//   node playlist.mjs recording <ISRC>
//       the MusicBrainz recordings with that ISRC: title, artist credit, sung language,
//       and every release group they appear on, plus `original` — the earliest Album/EP
//       with no secondary type (not a compilation, live, soundtrack, remix…).
//
// Genres, Simplified Chinese conversion and the CSV itself come from the populate-songs
// helper (../populate-songs/songs.mjs: genre, simplify, csv), so both skills write the same.
//
// Spotify credentials (Client Credentials flow, public playlists only) come from the
// SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET environment variables, or from
// secret/spotify.json ({"clientId": "…", "clientSecret": "…"}) — `secret/` is gitignored.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UA = 'standalone-ranker-populate-playlist/1.0 ( https://github.com/wujo635/standalone-ranker )';
const MB = 'https://musicbrainz.org/ws/2/';
// Same names as populate-songs' songs.mjs, so both skills write the same Language values.
const LANGS = { eng: 'English', jpn: 'Japanese', kor: 'Korean', zho: 'Chinese', spa: 'Spanish',
  cmn: 'Mandarin', yue: 'Cantonese', nan: 'Hokkien', hak: 'Hakka',
  fra: 'French', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian', hin: 'Hindi',
  tha: 'Thai', vie: 'Vietnamese', tgl: 'Tagalog', ind: 'Indonesian', swe: 'Swedish', nld: 'Dutch',
  ara: 'Arabic', tur: 'Turkish', pol: 'Polish', heb: 'Hebrew', mul: 'Multiple',
  zxx: 'Instrumental' };

// --- Spotify ---------------------------------------------------------------------

function credentials() {
  let id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  const file = join(ROOT, 'secret', 'spotify.json');
  if ((!id || !secret) && existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    id = id || j.clientId; secret = secret || j.clientSecret;
  }
  if (!id || !secret) throw new Error('No Spotify credentials: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, or create secret/spotify.json with {"clientId": "...", "clientSecret": "..."}');
  return { id, secret };
}

async function token() {
  const { id, secret } = credentials();
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status}): check the Client ID and Secret`);
  return (await res.json()).access_token;
}

async function spotify(url, tok) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
    if (res.status === 429) { // rate limited: wait as told, then retry
      await new Promise(r => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000));
      continue;
    }
    if (res.status === 404) throw new Error('Spotify says this playlist doesn\'t exist or isn\'t readable. It may be private or collaborative, or made by Spotify (editorial, Daily Mix, Discover Weekly, Blend) — new apps can\'t read those.');
    if (!res.ok) throw new Error(`Spotify ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error('Spotify kept rate-limiting; try again in a minute');
}

// Accepts https://open.spotify.com/playlist/<id>?si=…, spotify:playlist:<id>, or the id.
function playlistId(ref) {
  const m = String(ref).match(/playlist[/:]([A-Za-z0-9]{22})/) || String(ref).match(/^([A-Za-z0-9]{22})$/);
  if (!m) throw new Error('Not a Spotify playlist link or id: ' + ref);
  return m[1];
}

// --- MusicBrainz -------------------------------------------------------------------

let lastCall = 0;
async function mb(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(MB + path + (path.includes('?') ? '&' : '?') + 'fmt=json', { headers: { 'User-Agent': UA } });
    if (res.status === 503) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; } // throttled
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${path}`);
    return res.json();
  }
  throw new Error('MusicBrainz kept throttling; try again shortly');
}

const credit = ac => (ac || []).map(c => c.name + (c.joinphrase || '')).join('');

const commands = {
  async playlist(ref) {
    const id = playlistId(ref);
    const tok = await token();
    const meta = await spotify(`https://api.spotify.com/v1/playlists/${id}?fields=name,owner(display_name),tracks(total)`, tok);
    const tracks = [], skipped = [];
    let url = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&additional_types=track,episode` +
      '&fields=next,items(is_local,track(type,name,is_playable,duration_ms,external_ids(isrc),artists(name),album(name,album_type,release_date)))';
    let n = 0;
    while (url) {
      const page = await spotify(url, tok);
      for (const it of page.items) {
        n++;
        const t = it.track;
        if (!t) { skipped.push({ n, reason: 'unavailable (removed from Spotify)' }); continue; }
        if (it.is_local) { skipped.push({ n, title: t.name, reason: 'local file (not on Spotify)' }); continue; }
        if (t.type !== 'track') { skipped.push({ n, title: t.name, reason: 'podcast episode' }); continue; }
        tracks.push({ n, title: t.name, artists: (t.artists || []).map(a => a.name),
          album: t.album?.name || '', albumType: t.album?.album_type || '', released: t.album?.release_date || '',
          isrc: t.external_ids?.isrc || '', length: Math.round((t.duration_ms || 0) / 1000) });
      }
      url = page.next;
    }
    return { name: meta.name, owner: meta.owner?.display_name || '', total: meta.tracks?.total ?? n, tracks, skipped };
  },

  async recording(isrc) {
    const hit = await mb(`isrc/${encodeURIComponent(isrc)}`);
    if (!hit || !hit.recordings?.length) return { isrc, recordings: [], releaseGroups: [], original: null };
    const recordings = [], groups = new Map();
    for (const r0 of hit.recordings.slice(0, 5)) {
      const r = await mb(`recording/${r0.id}?inc=artist-credits+releases+release-groups+work-rels&status=official`);
      if (!r) continue;
      const rel = (r.relations || []).find(x => x.type === 'performance' && x.work);
      const langs = rel ? (rel.work.languages?.length ? rel.work.languages : [rel.work.language].filter(Boolean)) : [];
      recordings.push({ id: r.id, title: r.title, artist: credit(r['artist-credit']), length: r.length ? Math.round(r.length / 1000) : null,
        ...(langs.length && { lyrics: langs.map(l => LANGS[l] || l).join('+') }),
        ...(rel?.attributes?.includes('instrumental') && { instrumentalVersion: true }) });
      for (const x of r.releases || []) {
        const g = x['release-group']; if (!g || groups.has(g.id)) continue;
        groups.set(g.id, { id: g.id, title: g.title, type: g['primary-type'] || '', secondary: (g['secondary-types'] || []).join('/'),
          date: g['first-release-date'] || x.date || '' });
      }
    }
    const releaseGroups = [...groups.values()].sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
    const original = releaseGroups.find(g => (g.type === 'Album' || g.type === 'EP') && !g.secondary) || null;
    return { isrc, recordings, releaseGroups, original };
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.error('Usage: node playlist.mjs playlist "<link>" | recording <ISRC>');
  process.exit(1);
}
try {
  console.log(JSON.stringify(await commands[cmd](...args), null, 1));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
// Helper for the populate-playlist skill: reads a public Spotify playlist and looks each
// track's recording up in MusicBrainz by ISRC. Every command prints compact JSON.
//
//   node playlist.mjs login
//       one-time Spotify login (prints a link; you approve read-only playlist access in the
//       browser). Saves a refresh token in secret/spotify-token.json; later runs renew it.
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
// Spotify no longer lets an app read a playlist's tracks without a user login (found
// 2026-10-14: /playlists/{id}/tracks is 403 and /items says "Valid user authentication
// required" for an app-only token, even for a public playlist). So this reads as the user:
// Authorization Code with PKCE, scopes playlist-read-private and playlist-read-collaborative,
// redirect http://127.0.0.1:8888/callback (registered on the app). The app's Client ID comes
// from SPOTIFY_CLIENT_ID or secret/spotify.json ({"clientId": "…", "clientSecret": "…"}; the
// secret isn't needed with PKCE). Tokens live in secret/spotify-token.json. secret/ is gitignored.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
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

const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative';
const TOKEN_FILE = join(ROOT, 'secret', 'spotify-token.json');

function clientId() {
  let id = process.env.SPOTIFY_CLIENT_ID;
  const file = join(ROOT, 'secret', 'spotify.json');
  if (!id && existsSync(file)) id = JSON.parse(readFileSync(file, 'utf8')).clientId;
  if (!id) throw new Error('No Spotify Client ID: set SPOTIFY_CLIENT_ID, or create secret/spotify.json with {"clientId": "..."}');
  return id;
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), ...params }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Spotify token request failed (' + res.status + (j.error_description ? ': ' + j.error_description : '') + ')');
  return j;
}

function saveToken(j, previous = {}) {
  const t = { accessToken: j.access_token, refreshToken: j.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + (j.expires_in || 3600) * 1000 - 60000, scope: j.scope || previous.scope };
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 1));
  return t;
}

// A valid user access token: the saved one, or renewed with the refresh token.
async function token() {
  if (!existsSync(TOKEN_FILE)) throw new Error('Not logged in to Spotify yet: run  node .claude/skills/populate-playlist/playlist.mjs login');
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  if (t.accessToken && t.expiresAt > Date.now()) return t.accessToken;
  try {
    return saveToken(await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken }), t).accessToken;
  } catch (e) {
    throw new Error(e.message + '. The login may have been revoked or expired: run the login command again.');
  }
}

// One-time browser login (Authorization Code with PKCE): print the link, catch the redirect on
// 127.0.0.1:8888, swap the code for tokens. Gives up after 5 minutes.
async function login() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(12).toString('base64url');
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ client_id: clientId(), response_type: 'code',
    redirect_uri: REDIRECT, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state });
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const q = new URL(req.url, REDIRECT).searchParams;
      if (!req.url.startsWith('/callback')) { res.writeHead(404).end(); return; }
      const ok = q.get('state') === state && q.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(ok ? '<p>Logged in to Spotify. You can close this tab.</p>' : '<p>Spotify login failed: ' + (q.get('error') || 'state mismatch') + '</p>');
      server.close(); clearTimeout(timer);
      ok ? resolve(q.get('code')) : reject(new Error('Spotify login failed: ' + (q.get('error') || 'state mismatch')));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('No login within 5 minutes; run login again')); }, 300000);
    server.on('error', e => reject(new Error('Cannot listen on 127.0.0.1:8888 (' + e.code + '); close whatever is using it and retry')));
    server.listen(8888, '127.0.0.1', () => console.log('Open this link to log in to Spotify (read-only playlist access):\n' + url));
  });
  const t = saveToken(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }));
  return 'Logged in. Token saved to secret/spotify-token.json (scopes: ' + t.scope + ').';
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
  login,

  async playlist(ref) {
    const id = playlistId(ref);
    const tok = await token();
    const meta = await spotify(`https://api.spotify.com/v1/playlists/${id}?fields=name,owner(display_name)`, tok);
    const tracks = [], skipped = [];
    // /items replaced /tracks, which now refuses app-only and user tokens alike (403).
    let url = `https://api.spotify.com/v1/playlists/${id}/items?limit=50&additional_types=track,episode`;
    let n = 0;
    while (url) {
      const page = await spotify(url, tok);
      for (const it of page.items) {
        n++;
        const t = it.track || it.item; // the playlist item's track (named `item` on newer responses)
        if (!t) { skipped.push({ n, reason: 'unavailable (removed from Spotify)' }); continue; }
        if (it.is_local) { skipped.push({ n, title: t.name, reason: 'local file (not on Spotify)' }); continue; }
        if (t.type !== 'track') { skipped.push({ n, title: t.name, reason: 'podcast episode' }); continue; }
        tracks.push({ n, title: t.name, artists: (t.artists || []).map(a => a.name),
          album: t.album?.name || '', albumType: t.album?.album_type || '', released: t.album?.release_date || '',
          isrc: t.external_ids?.isrc || '', length: Math.round((t.duration_ms || 0) / 1000) });
      }
      url = page.next;
    }
    return { name: meta.name, owner: meta.owner?.display_name || '', total: n, tracks, skipped };
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
  console.error('Usage: node playlist.mjs login | playlist "<link>" | recording <ISRC>');
  process.exit(1);
}
try {
  const out = await commands[cmd](...args);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

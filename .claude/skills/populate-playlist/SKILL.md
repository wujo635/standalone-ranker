---
name: populate-playlist
description: Build an import-ready CSV for standalone-ranker's Songs category from a public Spotify playlist link, crediting each song to its original album via MusicBrainz (by ISRC) and Wikipedia for genres, the same way populate-songs does. Use when the user says things like "add this Spotify playlist to Songs", "populate Songs from <playlist link>", or pastes an open.spotify.com/playlist link to import.
---

# Populate Playlist

Turn a public Spotify playlist into a CSV the user imports into the **Songs** category (Data tab
→ Import CSV → **Bulk add**). This is the playlist counterpart of the **populate-songs** skill
(`.claude/skills/populate-songs/SKILL.md`). Its field rules (step 4) and library check (step 5)
apply here unchanged, so read that file first and follow it wherever this one says "as in
populate-songs". Never write to Firestore or the app's storage directly.

Two helpers, run from the repo root:

```bash
node .claude/skills/populate-playlist/playlist.mjs <command> ...
node .claude/skills/populate-songs/songs.mjs <command> ...
```

| Command | Returns |
|---|---|
| `playlist.mjs playlist "<link>"` | the playlist's name, owner, and every track: Spotify `title`, `artists` (all of them, in Spotify's order), Spotify's `album`/`albumType`/`released`, `isrc`, `length`. Local files, podcast episodes and removed tracks are under `skipped`. |
| `playlist.mjs recording <ISRC>` | the MusicBrainz recordings with that ISRC (title, artist credit, sung `lyrics` language, `instrumentalVersion`), every release group they appear on, and `original`: the earliest Album or EP with no secondary type |
| `songs.mjs albums` / `editions` / `tracks` | as in populate-songs, for when the ISRC lookup isn't enough (step 3) |
| `songs.mjs genre "<Wikipedia page title>"` | album genres, as in populate-songs |
| `songs.mjs simplify "<text>"` / `csv <rows.json> <out.csv>` | Simplified Chinese preview / write the CSV (converts every Chinese character to Simplified) |

## Setup and limits

- **Credentials.** The `playlist` command needs a Spotify app's Client ID and Secret: from the
  `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` environment variables, or from
  `secret/spotify.json` (`{"clientId": "...", "clientSecret": "..."}`; `secret/` is
  gitignored). If they're missing, tell the user how to make them: developer.spotify.com →
  Dashboard → Create app (any name; redirect URI `http://127.0.0.1:8888/callback`, unused) → copy
  the Client ID and Secret into that file. **Don't ask the user to paste the secret in chat.**
- **Public playlists only** (the user's choice). Spotify's app-only access can read any public
  playlist by link, including ones other people shared. It can't read **private** or
  **collaborative** playlists, or playlists **made by Spotify** (editorial ones like Today's Top
  Hits, Daily Mix, Discover Weekly, Blend), which are blocked for apps created after November 2024.
  The helper reports a 404 with that explanation; pass it on and suggest making the playlist
  public, or copying its songs into a public playlist of the user's own.

## Workflow

### 1. Read the playlist
`playlist "<link>"`. Say how many tracks were found and list anything in `skipped`, with the reason.

### 2. Look each track up by ISRC
`recording <ISRC>` for every track. MusicBrainz allows one request a second and each lookup
takes two or more, so a long playlist takes minutes. Say so up front for anything over ~50 tracks.
- **Deduplicate the playlist first:** the same ISRC twice, or the same song in two versions
  (compare as in populate-songs' "Deduplicate within the run"). Keep one, and list the rest.
- A track with no ISRC, or one MusicBrainz doesn't know, goes to step 3's fallback.

### 3. Credit the original album
The user wants each song credited to the **original album it first appeared on**, not
Spotify's album (often a single, deluxe, remaster or best-of).
- Use `original` from `recording`: Album (title, using the bilingual form as in populate-songs),
  Year Released (from its date), and that album's Genre (`genre`, as in populate-songs).
- **Fallbacks, in order:** no `original` (only singles or compilations), or no MusicBrainz
  match → look for the song on the artist's albums and EPs with `songs.mjs albums` and `tracks`,
  matching the title, as populate-songs does for regional versions. If it's on none, it's a
  non-album single: Album blank, Year Released from the single (the earliest release group of
  type Single) or, failing that, Spotify's `released`. Mark every fallback in the preview.
- **An ISRC is one exact recording,** so `original` is that recording's first album, not
  necessarily the song's. A playlist's Japanese version leads to the Japanese release (Red
  Velvet's Japanese "Red Flavor" → *#Cookie Jar*), and a re-recording to its own album. When the
  `lyrics` language or the album differs from the song's original release, treat it as a
  language version (as in populate-songs) and ask whether the user wants the original instead.
- Never take Spotify's album name just because it's there. A Spotify album that is a compilation,
  live album or "Greatest Hits" is a clue that the original is elsewhere.

### 4. Fill the fields
As in populate-songs' step 4 (Title, Artist, Album, Year Released, Language, Genre; instrumentals;
language versions; Simplified Chinese), with these playlist specifics:
- **Title:** start from the MusicBrainz recording title, which gives the bilingual form
  (`빨간 맛 (Red Flavor)`) where Spotify may give only one language. Strip Spotify's version
  suffixes: " - Remastered 2011", " - Radio Edit", " - From the film …", "(Live)".
  If the suffix marks a genuinely different version (live, remix, acoustic, a different-language
  version), say so in the preview: the user may want the original instead.
- **Featured artists:** Spotify's "(feat. X)" / "(with X)" in a title becomes the `(ft. X)`
  form, as in populate-songs.
- **More than one artist:** Spotify lists every artist equally and doesn't say who's featured.
  **Ask per song** (the user's choice): list every multi-artist track in the preview with
  Spotify's artist order, the MusicBrainz credit (`artist` from `recording`, which often shows
  "feat." or "&"), and a suggested credit, then let the user decide each before writing. See
  TODO.md's "Decide how Songs credits collaborations" for the open question behind this.
- **Language:** `lyrics` from `recording` when present; otherwise as in populate-songs.
- **Artist spelling:** reuse the library's exact spelling when the artist is already there (step 5).

### 5. Check against the library
As in populate-songs' step 5, against `imports/songs.csv` (the user's Songs export). Playlists
often contain songs already imported from an album, so expect many "already in library" rows.
Leave them out; Bulk add would overwrite fields the user edited.

### 6. Preview, then write
One table in playlist order: #, Title, Artist, Album, Year Released, Language, Genre. Then list:
skipped tracks, dropped duplicates, songs already in the library, album fallbacks (step 3), the
multi-artist credits to decide, missing genres, language overrides, and version notes. Ask
"Write the CSV?" and let the user edit first. Then write the rows as JSON to the session
scratchpad and run `songs.mjs csv <rows.json> imports/playlist-<playlist-slug>.csv` (a
lowercase-hyphenated slug of the playlist name). Open it and check the header, row count and
titles.

### 7. Hand off
The file path, the row count, and the import steps: Data tab → Import CSV → choose the file →
answer **1 (Bulk add)**, never 2 (Replace wipes the category's rankings).

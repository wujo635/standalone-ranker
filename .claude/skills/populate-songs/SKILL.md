---
name: populate-songs
description: Build an import-ready CSV of songs for standalone-ranker's Songs category from an artist's discography or specific albums/EPs, using MusicBrainz for track lists and Wikipedia for genres. Use when the user says things like "populate Songs with Linkin Park's discography", "add Meteora to Songs", or "add <artist>'s albums to the ranker".
---

# Populate Songs

Turn "add <artist>'s discography" or "add <album>" into a CSV the user imports into the
**Songs** category (Data tab → Import CSV → **Bulk add**). Never write to Firestore or the
app's storage directly — import goes through `bulkAddCSVImport()`, which handles ids,
tombstones, and sync.

All lookups go through the helper next to this file (it rate-limits MusicBrainz to 1 req/s
and sends a proper User-Agent). Run it from the repo root:

```bash
node .claude/skills/populate-songs/songs.mjs <command> ...
```

| Command | Returns |
|---|---|
| `artist "<name>"` | candidate artists: id, name, country, disambiguation |
| `albums <artistId> [--all]` | Albums, then EPs, then Singles, by date, with MusicBrainz's `note` when it has one. Live/compilation/remix/demo releases are excluded unless `--all` is passed; those then carry a `secondary` type. |
| `editions <releaseGroupId>` | official releases of one album: date, country, edition name, track count |
| `tracks <releaseId>` | album title, first-release year, language, and the track list |
| `genre "<Wikipedia page title>"` | genres from the infobox (follow `redirect` if returned) |
| `csv <rows.json> <out.csv>` | writes the preload CSV (handles quoting, curly quotes, header/directives) |

## Workflow

### 1. Resolve the artist
`artist "<name>"`. If the top result isn't clearly right (several plausible names, low score,
same-name artists), ask the user to choose, showing country and disambiguation.

### 2. Pick releases
`albums <artistId>`.

- **A single album or EP was named:** match it by title and continue. If more than one release
  group matches, ask, showing each one's year and `note`.
- **A regional version, a compilation, or a release that isn't among the results.** Examples:
  "the 1997 US version", "the American debut", "Greatest Hits", or a named album that
  `albums` doesn't list. Re-run with `albums <artistId> --all` and match on the title, year,
  and `note`. MusicBrainz often files regional repackages as compilations; the 1997 US
  *Backstreet Boys* is one. Before going further, check where the songs first appeared:
  - A song from an original album may already be in the library, credited to that album.
    Importing it again overwrites its Album and Year Released.
  - Ask whether to credit each song to the requested release, or to the original album it
    first appeared on. For the second option, take Album, Year Released and Genre from that
    original album.
  - Only take the second option if you can actually find the song on an original album with
    `albums` and `tracks`. Don't guess. If you can't, credit the requested release.
- **A discography was requested:** show a numbered list in chat — studio albums first, then
  EPs — each with its year, and ask which numbers to include (accept "all", "1-4", "all but 6",
  etc.). Don't use AskUserQuestion here: it only shows 4 options. Then ask whether to also add
  **non-album singles**, meaning singles whose song doesn't appear on any selected album or
  EP. To find them, compare each single's title against the track lists you've collected.

### 3. Get each release's tracks
For every selected album or EP:

1. `editions <rgId>`. Use the **earliest standard edition** (no edition name, usually the
   lowest track count among the early dates) as the base track list. Get it with `tracks`.
2. **Include bonus/deluxe tracks.** If there's a deluxe, bonus, expanded, or anniversary edition
   with more tracks, fetch the most complete one and add tracks that are **distinct songs** not
   already on the list.
   - Skip versions of songs already listed: live, remix, demo, instrumental, acoustic,
     a cappella, radio/single edit, remaster.
   - A track that is a previously unreleased song is a distinct song, so keep it.
   - A bonus track still gets the original album's name in Album, not "Meteora (Deluxe)".
3. **Skip non-song tracks:** intros, interludes, skits, spoken outros. Clues are the length
   (usually under ~60s) or a title like "Intro", "Foreword", "Interlude". List what you skipped
   in the preview so the user can add any back.

### 4. Fill the fields

| Field | Rule |
|---|---|
| Title | The track title as listed. Drop version suffixes like "- 2023 Remaster". Keep the song's real parenthetical subtitle if it has one. |
| Artist | The release's main artist exactly as credited (e.g. `Linkin Park`). Leave featured guests ("feat. X") out of Artist, so the Artist filter stays clean. For a release credited jointly (e.g. "Linkin Park & Jay-Z"), use the full joint credit. |
| Album | The release-group title (the original album name). Leave blank for a non-album single. |
| Year Released | The album's first-release year (`year` from `tracks`). For a non-album single, use the single's year. |
| Language | `language` from `tracks`. If it's missing, use the artist's main language. If a track is known to be in a different language, override it for that track only. |
| Genre | The album's genres: `genre "<Album> (album)"`, falling back to `"<Album>"` or `"<Album> (<Artist> album)"`. Take the first 1–3, comma-separated (Genre is a multi-value field). The same value goes on every track of that album. For a non-album single, try the song's own page, then the artist's. If nothing is found, leave it blank. Don't guess. |

**Deduplicate within the run.** If the same song shows up on two selected releases (a single
and its album, or an EP and a later album), keep **one** row, using the earliest *album*
appearance. To match, compare titles case-insensitively with punctuation and
feat./version suffixes ignored.

### 5. Check against the existing library (if available)
If `imports/songs-library.csv` exists, it's the user's own "Export category as CSV" of Songs.
Leave out songs already in it, matching on the normalized Title + Artist, and list them as
"already in library".

This matters because Bulk add **overwrites** the fields of matching items, blank values
included, so re-importing a song would wipe a Genre or Album the user edited by hand. If the
file doesn't exist, say once in the final message that exporting Songs to that path enables
this check.

### 6. Preview, then write
Show a compact preview: one table per release (#, Title, Year Released, Genre), plus a short list of
anything skipped or uncertain:
- skipped tracks
- dropped duplicates
- songs already in the library
- missing genres
- language overrides

Ask "Write the CSV?" (allow edits first). Then:

1. Write the rows as a JSON array of `{Title, Artist, Album, "Year Released", Language, Genre}` (the keys must match the Songs schema's field names exactly; `csv` rejects unknown keys) to the
   session scratchpad.
2. Run `csv <rows.json> imports/<artist-slug>[-<album-slug>].csv`. `imports/` is gitignored.
   Use a lowercase-hyphenated slug.
3. Open the file and check it: the header row, the row count, and no unexpected blank Titles.

### 7. Hand off
Tell the user the file path, the row count, and the import steps:
1. Data tab → Import CSV → choose the file.
2. Answer **1 (Bulk add)** at the prompt. Never 2: Replace wipes the category's rankings.

Remind them, briefly, that a song's id is its title plus any identity fields. Unless **Artist**
is flagged as an identity field in the Songs schema editor, a new song with the same title as
an existing one (another artist's "Numb", say) overwrites that item instead of being added.
Mention this once per conversation, not on every run.

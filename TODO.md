# To-do / Future Work

Tracks ideas and known gaps noted in `ARCHITECTURE.md` but not yet scheduled. Not a changelog — once something here ships, move its entry to `CHANGELOG.md` and delete it from this list.

## Sync / data model

- **Undo for item/category deletions.** Deletions are permanent today (confirm prompt only, no undo stack). Would need a soft-delete (`deleted: true`) plus a "Recently deleted" view. [ARCHITECTURE.md "Item deletions"](ARCHITECTURE.md)
- **(Explore — not required) Sync `filterable`/`required` changes on existing fields.** Today `adoptIncomingFields()` only adopts brand-new fields and newly-on `identity` flags; toggling an already-shared field's filterable (🔍/∅) or required setting stays on the device that did it, deliberately ("low stakes if they diverge"). Built-in categories (Movies, Songs) start from the default schema everywhere, so even a device adopting a fresh baseline never picks the change up. Side effect: the root doc's `schema` flip-flops with whoever uploaded last. If it should sync: per-field last-write-wins, which needs a timestamp per field setting (e.g. `filterableAt`) since the root doc's `updatedAt` covers the whole schema; consider whether filterable is better as a per-device preference, like `hidden`. Note the toggle only affects the filter panel — Library search matches every field regardless. [ARCHITECTURE.md "Item identity fields"](ARCHITECTURE.md)
- **Expand cloud sync beyond two users.** Deliberately out of scope for now. Short-term: swap the hardcoded two-UID Firestore rule for an allowlist collection. Long-term (self-serve, multiple groups): a from-scratch redesign of the sync layer, not an incremental change. [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)

## Library data

- **Decide how Songs credits collaborations, then conform the library.** A song credited to two or more main artists has been entered two different ways, and neither filters well:
  - **Full joint credit as Artist** (the `populate-songs` skill's current rule, used in the earliest imports): `bad decisions` → `benny blanco, BTS & Snoop Dogg`; `My Universe` → `Coldplay x BTS`; `Beautiful Christmas` → `Red Velvet × aespa`. Each joint string is its own Artist filter value, so filtering by BTS or Red Velvet misses these songs.
  - **Kept under the artist being imported, partner as `(ft. …)` in the title** (what was chosen in every import since 2026-10-12, even where the official credit is equal billing): `Lollipop (ft. 2NE1)` (BIGBANG), `芳華絕代 (ft. 梅艷芳)` (張國榮 (Leslie Cheung)), and BLACKPINK's `Ice Cream (ft. Selena Gomez)`, `Kiss and Make Up (ft. Dua Lipa)`, `Sour Candy (ft. Lady Gaga)`. Filters cleanly by that artist, but the partner's filter misses the song, and "ft." isn't always the official credit.
  - **Featured-only credits aren't affected:** a song where X is officially featured stays under the main artist as `(ft. X)`, e.g. `Waste It on Me (ft. BTS)` under Steve Aoki.
  - **Options:** (a) adopt the `(ft. …)` form everywhere and rename the three full-credit songs to match; (b) make Artist multi-value (`multi: true`, like Genre: filtering already splits on commas) and write every main artist as a comma list, e.g. `benny blanco, BTS, Snoop Dogg`, so each artist's filter finds the song. With (b), an artist name that itself contains a comma would split, and the `(ft. …)` songs above would also be converted to comma lists.
  - **Conforming is safe:** editing a song's Title or Artist in the app is a rename (`saveItem()`, renamedTo tombstone), so it keeps the rating and syncs. Re-importing a CSV instead would add second copies, because Artist is an identity field.
  - **Then:** update the `populate-songs` skill's Artist rule (`.claude/skills/populate-songs/SKILL.md`) to match, so new imports stop proposing the full joint credit.

## Ranking quality

Motivation: in a large category, a new item takes a long time to find where it belongs. Every item starts at 1000, every match moves it by at most K = 32 (`eloUpdate()`), so an item far from 1000 needs many matches to get there. This matters most in NBA Players (~4,900 items). Proposed in the 2026-09-23 review (item 6). Better pairing (item 5) shipped in 2.28.0 — under-played items are now drawn far more often — so this is the remaining half: it changes how ratings are computed, so it needs the sync check noted below.

- **Faster rating for new items (provisional K).** A bigger rating swing while an item has few matches, so a new item moves toward its real level in fewer comparisons. Worked out in the 2026-10-20 design discussion:
  - **Schedule:** K = 96 at 0 matches, easing to 32 over the first 20–30 — the best of the schedules simulated alongside 2.28.0's draws (a flat 48 for 10 matches barely helped). Unsettled items will visibly jump at first.
  - **K per side:** each item's K from its *own* match count, so a settled item isn't knocked around by a new one (the update stops being zero-sum, which is fine for ranking).
  - **Sync — store each side's K on the match record** (`kw`/`kl` in `matchLog` and the Firestore match doc). Every device rebuilds ratings by applying matches as deltas (`applyNewMatches()`), and the match counts it sees at that moment differ from the voter's, so computing K on receipt would make devices disagree. Matches without `kw`/`kl` (all existing history) keep K = 32, so current ratings don't change. Catch: every device must update before anyone votes, or an old one applies 32 and drifts; a Reset re-aligns ratings anyway.
  - **Never derive K from match history** — after a Reset the cloud has none and an adopting device only has post-reset matches. Use `wins + losses` on the item, which the packed baseline carries.
  - **Undo/history** stores each update's change, so it should keep working as is.
  [ARCHITECTURE.md "ELO ranking"](ARCHITECTURE.md)

## UI / persistence gaps

- **Wire up `settings.userName`.** Added in schema v4 alongside `deviceId` but never used in any UI; reserved for human-readable attribution on history entries. [ARCHITECTURE.md "Known gaps in the merge model"](ARCHITECTURE.md)

## Scale / infra

- **Virtual scrolling (only if needed).** Library is paginated (2.6.0) and Leaderboard uses infinite scroll (2.16.0), but Leaderboard rows are never recycled, so scrolling very deep or using Show all still puts every row in the DOM. clusterize.js-style virtualization would cap that. [ARCHITECTURE.md "Rendering"](ARCHITECTURE.md)
- **localStorage cap (~5MB).** Roughly 10,000 items before issues. Fix: switch to IndexedDB. [ARCHITECTURE.md "localStorage cap"](ARCHITECTURE.md)
- **Switch localStorage → real backend.** Swap `save()`/`load()` for `fetch()` calls against a REST API or serverless function; state is already JSON-serializable. [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)

## Larger, speculative

- **Extend the CSV preload format** with new `#directive` types (e.g. `#description`). [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)
- **Port to a framework** (React/Vue) — the app is intentionally framework-free today. [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)

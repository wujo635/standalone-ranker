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

Motivation: in a large category, a new item takes a long time to find where it belongs. Every item starts at 1000, every match moves it by at most K = 32 (`eloUpdate()`), and only Tier mode puts never-ranked items first (`startTierSession()`, up to half a session). This matters most in NBA Players (~4,900 items). Proposed in the 2026-09-23 review (items 5 and 6). Pairing is local to the Rank view; provisional K changes how ratings are computed, so it needs the sync check noted below.

- **Better pairing.** Today nothing stops the same pair from coming up twice in a row, and Smart pairing in 1v1 (`smartPair()`) pairs a random anchor with the *single* closest-ELO item, so tight rating clusters keep producing the same pairs. Cheap wins:
  - skip recently shown pairs (a short in-memory list, e.g. the last 10–20);
  - pick randomly among the closest few items (e.g. 3–5) instead of always the closest;
  - favour items with few matches (`wins + losses`), as Tier already does for never-ranked items, so new items get compared sooner — in Podium and 1v1 too.
  [ARCHITECTURE.md "Ranking modes"](ARCHITECTURE.md)
- **Faster rating for new items (provisional K).** A bigger rating swing while an item has few matches — e.g. K = 48 until it has played 10, then 32 — so a new item moves toward its real level in fewer comparisons. To work out first:
  - K per side: each item's K from its *own* match count, so a settled item isn't knocked around by a new one (the update stops being zero-sum, which is fine for ranking);
  - sync: ratings are applied as deltas from matches on each device (`applyNewMatches()`), so the match count used for K has to be the one at the time of the match, or two devices can compute different swings for the same vote — check this against the existing "Match order across devices" gap;
  - undo/history stores each update's change, so it should keep working as is.
  [ARCHITECTURE.md "ELO ranking"](ARCHITECTURE.md)

## UI / persistence gaps

- **"Look it up" link on Rank cards.** A small search icon on the items being compared in the Rank view (1v1, Podium, Tier) that opens a web search in a new tab, so a user who doesn't recognize a title — typically a song — can check it before picking. Decided:
  - **Per-category toggle, off by default** (e.g. a `lookup` flag on `state.schema[cat]`, set in the category's schema editor), so it works for Songs, Movies, or anything else. Since it lives on the schema, it syncs like any other schema change.
  - **Rank view, not Library** — that's where an unfamiliar title actually gets in the way.
  - **YouTube search link**, so the user can hear the song: `https://www.youtube.com/results?search_query=` + `encodeURIComponent(title + ' ' + identity fields)` (for Songs, Title + Artist), opened with `target="_blank" rel="noopener"`. This is a plain link to YouTube's search page, not the YouTube Data API, so there's no API key and no quota. Possibly a per-category choice of YouTube vs. Google.
  - **Must not trigger a pick:** the icon needs its own `data-action` and must stop the click from reaching the card's pick handler (1v1/Podium cards are click targets); give it a tap target big enough on mobile and pin it with a click test that a lookup click records no match.
- **Wire up `settings.userName`.** Added in schema v4 alongside `deviceId` but never used in any UI; reserved for human-readable attribution on history entries. [ARCHITECTURE.md "Known gaps in the merge model"](ARCHITECTURE.md)

## Scale / infra

- **Virtual scrolling (only if needed).** Library is paginated (2.6.0) and Leaderboard uses infinite scroll (2.16.0), but Leaderboard rows are never recycled, so scrolling very deep or using Show all still puts every row in the DOM. clusterize.js-style virtualization would cap that. [ARCHITECTURE.md "Rendering"](ARCHITECTURE.md)
- **localStorage cap (~5MB).** Roughly 10,000 items before issues. Fix: switch to IndexedDB. [ARCHITECTURE.md "localStorage cap"](ARCHITECTURE.md)
- **Switch localStorage → real backend.** Swap `save()`/`load()` for `fetch()` calls against a REST API or serverless function; state is already JSON-serializable. [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)

## Larger, speculative

- **Extend the CSV preload format** with new `#directive` types (e.g. `#description`). [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)
- **Port to a framework** (React/Vue) — the app is intentionally framework-free today. [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)

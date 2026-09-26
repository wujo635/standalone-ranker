# To-do / Future Work

Tracks ideas and known gaps noted in `ARCHITECTURE.md` but not yet scheduled. Not a changelog — once something here ships, move its entry to `CHANGELOG.md` and delete it from this list.

## Sync / data model

- **Undo for item/category deletions.** Deletions are permanent today (confirm prompt only, no undo stack). Would need a soft-delete (`deleted: true`) plus a "Recently deleted" view. [ARCHITECTURE.md:812](ARCHITECTURE.md:812)
- **Expand cloud sync beyond two users.** Deliberately out of scope for now. Short-term: swap the hardcoded two-UID Firestore rule for an allowlist collection. Long-term (self-serve, multiple groups): a from-scratch redesign of the sync layer, not an incremental change. [ARCHITECTURE.md:746](ARCHITECTURE.md:746)

## UI / persistence gaps

- **Wire up `settings.userName`.** Added in schema v4 alongside `deviceId` but never used in any UI; reserved for human-readable attribution on history entries. [ARCHITECTURE.md:827](ARCHITECTURE.md:827)

## Scale / infra

- **Virtual scrolling (only if needed).** Library is paginated (2.6.0) and Leaderboard uses infinite scroll (2.16.0), but Leaderboard rows are never recycled, so scrolling very deep or using Show all still puts every row in the DOM. clusterize.js-style virtualization would cap that. [ARCHITECTURE.md "Rendering"](ARCHITECTURE.md)
- **localStorage cap (~5MB).** Roughly 10,000 items before issues. Fix: switch to IndexedDB. [ARCHITECTURE.md:802](ARCHITECTURE.md:802)
- **Switch localStorage → real backend.** Swap `save()`/`load()` for `fetch()` calls against a REST API or serverless function; state is already JSON-serializable. [ARCHITECTURE.md:726](ARCHITECTURE.md:726)

## Larger, speculative

- **Extend the CSV preload format** with new `#directive` types (e.g. `#description`). [ARCHITECTURE.md:705](ARCHITECTURE.md:705)
- **Port to a framework** (React/Vue) — the app is intentionally framework-free today. [ARCHITECTURE.md:730](ARCHITECTURE.md:730)

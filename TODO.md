# To-do / Future Work

Tracks ideas and known gaps noted in `ARCHITECTURE.md` but not yet scheduled. Not a changelog — once something here ships, move its entry to `CHANGELOG.md` and delete it from this list.

## Sync / data model

- **Replace rename tombstone with a real rename log.** Editing an item's title or an identity field currently computes a new deterministic id and tombstones the old one (`saveItem()`, [index.html:1405](index.html:1405)) — same mechanism as a real delete. This orphans local `matchLog`/`history` entries pointing at the old id, and can permanently block reusing that exact title+identity combo later (the "Superman" incident, [ARCHITECTURE.md:329](ARCHITECTURE.md:329)). Proposed fix: an append-only `itemRenames` log (`{oldId, newId, ts, deviceId}`), unioned like `matchLog`, applied on merge via the existing `remapItemIds()` machinery instead of delete-then-recreate. Needs a new Firestore subcollection and a schema-version bump. See [ARCHITECTURE.md:822](ARCHITECTURE.md:822).
- **Undo for item/category deletions.** Deletions are permanent today (confirm prompt only, no undo stack). Would need a soft-delete (`deleted: true`) plus a "Recently deleted" view. [ARCHITECTURE.md:812](ARCHITECTURE.md:812)
- **Expand cloud sync beyond two users.** Deliberately out of scope for now. Short-term: swap the hardcoded two-UID Firestore rule for an allowlist collection. Long-term (self-serve, multiple groups): a from-scratch redesign of the sync layer, not an incremental change. [ARCHITECTURE.md:746](ARCHITECTURE.md:746)

## UI / persistence gaps

- **Persist Smart pairing toggle.** `smartPairMode` resets to `false` on reload; needs adding to `state`. [ARCHITECTURE.md:724](ARCHITECTURE.md:724)
- **Persist ranking mode (1v1/Podium).** Resets to Standard on reload; same fix shape as above. [ARCHITECTURE.md:465](ARCHITECTURE.md:465)
- **Wire up `settings.userName`.** Added in schema v4 alongside `deviceId` but never used in any UI; reserved for human-readable attribution on history entries. [ARCHITECTURE.md:827](ARCHITECTURE.md:827)

## Scale / infra

- **Rendering at scale.** `renderLibrary()`/`renderLB()` rebuild via `innerHTML` on every update; flicker starts at 500–2,000 items/category. Fix: virtual scrolling (clusterize.js) or paginate. [ARCHITECTURE.md:791](ARCHITECTURE.md:791)
- **localStorage cap (~5MB).** Roughly 10,000 items before issues. Fix: switch to IndexedDB. [ARCHITECTURE.md:802](ARCHITECTURE.md:802)
- **Switch localStorage → real backend.** Swap `save()`/`load()` for `fetch()` calls against a REST API or serverless function; state is already JSON-serializable. [ARCHITECTURE.md:726](ARCHITECTURE.md:726)

## Larger, speculative

- **Extend the CSV preload format** with new `#directive` types (e.g. `#description`). [ARCHITECTURE.md:705](ARCHITECTURE.md:705)
- **Port to a framework** (React/Vue) — the app is intentionally framework-free today. [ARCHITECTURE.md:730](ARCHITECTURE.md:730)

# Ranker — Architecture & Developer Guide

A single-file web app for ranking anything using pairwise ELO comparisons. Categories are fully user-defined with custom fields. No build step, no dependencies, no server required.

This document describes how the app works **now**. Version tags like "(2.9.0)" say when something was introduced; the story of why — bug reports, incidents, earlier designs — lives in [CHANGELOG.md](CHANGELOG.md).

---

## Quick start

Open `index.html` in any modern browser. That's it.

To run the tests (development only — the app itself needs no install): `npm install` once, then `npm test`. See "Testing" below.

---

## Current versions

| | Value |
|---|---|
| App version | `2.18.5` |
| Data schema version | `6` |
| localStorage key | `ranker-v1` |

Both constants live at the top of the `<script>` block and are the single source of truth. The Data tab displays them at runtime alongside the schema version of whatever is currently saved to localStorage. CI (`.github/workflows/docs-sync-check.yml`) fails if this table and the code disagree.

### How to bump versions

1. Update `APP_VERSION` following semver: major = breaking/needs migration, minor = new feature, patch = bug fix or internal refactor.
2. If `state`'s shape changed, also bump `DATA_SCHEMA_VERSION` (see below).
3. Update the "Current versions" table above.
4. Add a row to the relevant table(s) in [CHANGELOG.md](CHANGELOG.md).

### Adding a new schema version

The migration and the version bump always travel together:

1. Increment `DATA_SCHEMA_VERSION`.
2. Add an `if (v < N)` block inside `migrateData()` that transforms the previous shape into the new one.
3. Add a fixture of the previous shape to `tests/migrate.test.js`.
4. Add rows to both tables in [CHANGELOG.md](CHANGELOG.md).

```js
if (v < 7) {
  // v6 → v7: describe what changed here
  Object.values(data.items || {}).forEach(item => { /* transform item shape */ });
}
```

`migrateData()` runs on both entry points for old data — `load()` (localStorage) and `importData()` (files) — so migrations apply however old data arrives. A purely additive optional field doesn't need a version bump: add a default to `migrateData()`'s unconditional "ensure new optional fields exist" tail instead (that's how `itemUndeletes`, `catDeletes`, `settings.rankMode`, etc. were added).

---

## File structure

The app is one file, `index.html`:

```
index.html
├── <style>     CSS custom properties + all component styles (~220 lines)
├── <body>      Seven views: Library, New Category, Schema Editor, Rank, Leaderboard, History, Data
└── <script>    All app logic (~3,400 lines of vanilla JS)
```

Development-only files alongside it (never loaded by the app):

```
package.json                   devDependency (jsdom) + `npm test` and `npm run simulate` scripts
tests/helpers/app.js           loads the real index.html into jsdom for tests
tests/helpers/sync.js          two-device helpers: simulated Firestore pull and file import
tests/helpers/firestore.js     in-memory Firestore for running the real upload/pull/reset/adopt code
tests/migrate.test.js          migrateData() version chain + load()
tests/merge.test.js            mergeImport(): items, matches, cloud pulls, tombstones, schema adoption
tests/rename.test.js           renames across two devices (2.17.0)
tests/readd.test.js            re-creating deleted titles/categories (2.17.1)
tests/ui.test.js               click-level tests: every interactive control, via real DOM events
tests/tier.test.js             Tier session pool size and priority (2.17.3)
tests/reset-baseline.test.js   reset, keep working, adopt later: ratings must match (2.18.1)
tests/identity-sync.test.js    turning on an identity field on a synced category (2.18.2); pulling items keyed before it (2.18.4); local items keyed before it (2.18.5)
tests/upload-cursors.test.js   what Upload sends after Adopt / a first pull (2.18.3)
tests/simulation/engine.js     randomized multi-device simulation: random user actions + sync steps, invariants, shrinking
tests/simulation/explore.js    `npm run simulate`: sweeps many seeds (one process each), shrinks and groups failures
tests/simulation.test.js       fixed passing seeds + each simulation finding as a minimal reproduction (`todo` until fixed)
.github/workflows/tests.yml    runs `npm test` on every PR and push to main
.github/workflows/docs-sync-check.yml   version table vs. code check
```

---

## Testing

Tests use Node's built-in runner (`node:test`) plus [jsdom](https://github.com/jsdom/jsdom), the only dependency, dev-only. `loadApp()` in `tests/helpers/app.js` loads the actual `index.html` into a fresh jsdom page per test and runs its inline script, so tests exercise exactly the code that ships. jsdom never fetches external `<script src>` tags, so the Firebase CDN doesn't load and the app takes its normal "cloud sync unavailable" path.

- **Driving the page:** `app.get(expr)`, `app.call(fnName, ...args)`, `app.run(code)`, and `app.setState(obj)` evaluate in the page's global scope, so they see top-level `let`/`const` bindings like `state`. `loadApp({ saved })` seeds `localStorage['ranker-v1']` before the script runs, for testing `load()`.
- **Everything crosses the boundary as JSON.** Objects created inside jsdom belong to another JS realm, which makes `assert.deepStrictEqual` fail on otherwise-identical values; JSON also mirrors how real data reaches the app.
- **Top-level `let` bindings aren't `window` properties.** To stub one (e.g. `cloudDb`, `cloudUser`), assign the bare identifier via `app.run('cloudUser = ...')`; `window.cloudUser = ...` silently does nothing.
- **Two-device tests** (`tests/helpers/sync.js`) model both sync paths exactly as the app calls them: a file import is `mergeImport(migrateData(json))`; a Firestore pull is `mergeImport(incoming, { cloudOrigin: true })` with item docs that carry no ratings and tombstones round-tripped through `tombstoneDoc()`/`tombstoneFromDoc()`.
- **Real Firestore code (2.18.1):** `tests/helpers/firestore.js` is an in-memory stand-in for the slice of the Firestore SDK the app uses; `connect(app, db)` points a page at it, signed in, with `confirm()` and `downloadJson()` stubbed. Several pages can share one `db`, so the real `uploadToFirestore()`, `pullFromFirestore()`, `resetSharedBaseline()`, and `adoptFreshBaseline()` run end to end (`await app.window.eval('uploadToFirestore()')`). It models what the app depends on: a plain `set()` replaces the whole doc, `{ merge }` deep-merges, `{ mergeFields }` replaces only the listed fields, server timestamps increase per commit (so `where('syncedAt', '>', …)` works), and `undefined` values are rejected. `db.written` lists every path written, so a test can assert exactly what an Upload sent.
- **UI paths:** where it matters, tests drive the real UI (e.g. renames go through the Library edit form, adds through the add form) rather than calling internals.
- **Click-level tests (`tests/ui.test.js`)** cover every interactive control with real DOM events, finding elements by id, text, aria-label, or title — never by their handler attribute — so they survive changes to how events are wired. Most assert the function a control calls (with its arguments) via `spy(name)`, which swaps the page's global function; handlers must therefore look functions up by name when the event fires. Every one of the app's event handlers is covered: removing any single one fails at least one test. jsdom has no `IntersectionObserver`, so `loadApp()` installs a no-op one.
- **Randomized simulation (`tests/simulation/`).** `Sim` drives three real pages against one in-memory Firestore through the same functions the UI calls (add/edit forms, Schema Editor, `deleteItem()`, CSV bulk add, votes, Upload/Pull/Reset/Adopt), with a shared clock that advances one second per step. It keeps its own model of what should exist — every film's current title/year, which votes should count, and what an Adopt legitimately erases — and checks after every step that every item is on its identity id and each device's W/L balance, and after a full sync that all devices agree, every live film exists exactly once, nothing deleted came back, and each film's W/L equals its counted votes. Documented tradeoffs ("Known gaps in the merge model") are tolerated, not reported. Steps are plain data, so a failure replays deterministically and `shrink()` reduces it to a minimal sequence. Wide sweeps run outside `npm test` (`npm run simulate -- --seeds 200`, optionally `--types`, `--steps`, `--concurrent`); `tests/simulation.test.js` keeps a few passing seeds plus each finding as a `todo` reproduction until it's fixed.
- **Regression-first:** sync/merge/migration tests are named after the CHANGELOG version whose bug they pin (e.g. "2.0.2", "2.5.2 / 2.7.3"). CLAUDE.md requires a test that fails without the fix for any such bug.

Not covered yet: the CSV parser, and Firestore upload/pull beyond the reset/adopt scenarios in `tests/reset-baseline.test.js`.

---

## Data model

All state is held in a single `state` object in memory and mirrored to localStorage.

```js
state = {
  cats: ['Movies', 'Songs', ...],       // ordered list of category names

  schema: {
    "Movies": {
      primary: 'Title',                 // label for the main field ("Name", "Title", "Place"...)
      fields: [
        // identity: part of the item's id (see "Item identity fields"); forces required
        { name: 'Year', required: true, filterable: true, identity: true },
        { name: 'Director', required: false, filterable: true }
      ]
    },
    "Songs": {
      primary: 'Title',
      fields: [
        { name: 'Artist', required: true },
        // multi: several comma-separated values, filtered per value (see "Multi-value fields")
        { name: 'Genre', required: false, multi: true },
        ...
      ]
    }
  },

  items: {
    "<id>": {
      id:        string,   // itemKey(cat, title, identitySuffix) — a deterministic hash, so two
                           // devices adding "the same" item get the same id with no coordination.
                           // Changing the title or an identity value changes the id (a rename).
      cat:       string,
      title:     string,   // value of the primary field
      fields:    { "Artist": "Radiohead", ... },
      elo:       number,   // starts at 1000
      wins:      number,
      losses:    number,
      hidden:    boolean,  // per-device preference: excluded from ranking/leaderboard, never synced
      updatedAt: number    // last title/field edit; drives last-write-wins on merge
    }
  },

  history: [               // last 50 rankings, for undo (local only, never synced)
    {
      type: 'standard'|'podium'|'tier', category, timestamp,
      winner: { id, title, eloChange }, loser: { id, title, eloChange },   // standard
      podium: [{ id, title, place }],                                      // podium
      tiers: [S[], A[], B[], C[], D[]],                                    // tier
      updates: [{ wid, lid, wChange, lChange }],                           // podium/tier undo
      matchIds: [...]      // matchLog entries this ranking created; removed on undo
    }
  ],

  // Every pairwise result this device knows about. Append-only, never compacted, unioned
  // by id on merge. Not guaranteed to be a device's complete lifetime history (data from
  // before schema v6 compacted it), which is why merges apply new matches as deltas on top
  // of live ratings instead of replaying — see "Merging rankings between devices".
  matchLog: [ { id, cat, wid, lid, ts, seq } ],     // id = `${deviceId}-${seq}`

  // Permanent tombstones, resolved per key by latest ts (see "Item deletions").
  // renamedTo marks a rename rather than a delete (see "Item renames").
  itemDeletes:   [ { itemId, ts, deviceId, title, cat, renamedTo? } ],
  itemUndeletes: [ { itemId, ts, deviceId, title, cat } ],
  catDeletes:    [ { cat, ts, deviceId } ],
  catUndeletes:  [ { cat, ts, deviceId } ],

  settings: {
    deviceId,            // random per browser; namespaces match ids
    matchSeq,            // this device's match counter
    smartPairMode,       // Rank tab toggle
    rankMode,            // 'standard' | 'podium' | 'tier'
    userName,            // reserved, unused (see "Known gaps in the merge model")
    lastUploadedSeq, lastUploadedItemsAt, lastUploadedDeletesAt, lastUploadedUndeletesAt,
    lastUploadedCatDeletesAt, lastUploadedCatUndeletesAt,   // Firestore upload cursors
    knownBaselineId      // last Firestore baseline this device has seen (see "Resetting the shared baseline")
  },

  lastSyncedServerTs: number | null   // Firestore pull cursor; null = never pulled
}
```

`freshState()` builds this shape (including a new `deviceId`); `clearAllData()` and the initial load both start from it. `title`/`cat` on tombstones are informational only, for the Deleted Items view.

### Export format

`exportData()` writes `buildExportPayload()`: the state plus a `_meta` block.

```json
{
  "_meta": { "appVersion": "2.17.1", "dataSchemaVersion": 6, "exportedAt": "2026-09-27T12:00:00.000Z" },
  "cats": [], "schema": {}, "items": {}, "history": [], "matchLog": [],
  "itemDeletes": [], "itemUndeletes": [], "catDeletes": [], "catUndeletes": [],
  "settings": {}
}
```

Per-device bookkeeping is stripped: `settings.deviceId`, `settings.userName`, `lastSyncedServerTs`, and every item's `hidden` flag (`itemsWithoutHidden()`). A recovery baseline file (see "Resetting the shared baseline") additionally has an empty `matchLog`, empty tombstone logs, and `_meta.matchLogCompacted: true`.

### CSV preload format

One file per category. `#directive` rows define the schema; the first non-`#` row is the column header; remaining rows are data.

```
#category,NBA Players
#primary,Name
#field,Team,optional
#field,Position,required
Name,Team,Position
LeBron James,Lakers,SF
Stephen Curry,Warriors,PG
```

- `#category` and `#primary` are required; each `#field` takes a name and `required`/`optional`. `filterable`/`identity`/`multi` flags don't round-trip through CSV.
- The header row must include the primary label and all field names; quoted values with commas are supported.
- Importing into an existing category prompts:
  - **Bulk add** (`bulkAddCSVImport()`) — matches rows by id (title + identity values); updates fields on matches, preserving ELO and W/L (only bumping `updatedAt` when a value actually changed); adds new rows at ELO 1000.
  - **Replace** — tombstones every existing item (`deleteItemsInCat()`), then imports the rows fresh at ELO 1000. Rows landing on a just-tombstoned id are undeleted automatically, so they survive the next sync (2.17.1).
  - **Cancel**.
- "Export category as CSV" (`exportCategoryCSV()`) writes this exact format without ratings — a clean library another user can start ranking from scratch.

### Persistence

`save()` serializes the whole `state` to `localStorage['ranker-v1']` on every write; `load()` reads it on startup, runs `migrateData()`, and restores per-device settings. A legacy `media-ranker-v1` key is migrated on first load.

- **Write failures are loud (2.15.0).** A failed `setItem` logs, toasts once, and sets `saveFailed`; `renderSaveWarning()` shows a persistent `#save-warning` banner ("Changes are not being saved", with **Export backup now**). The wording distinguishes a full quota (`QuotaExceededError`/`NS_ERROR_DOM_QUOTA_REACHED`) from blocked storage. It clears on the next successful write.
- **Near-full warning.** Once the last write reaches `LS_WARN_RATIO` (80%) of `LS_LIMIT_CHARS` (~5.2M characters) the banner shows a softer "N% full" warning, and the Data tab shows **Browser storage used**.
- **Unreadable saved data pauses saving (2.16.1).** If `ranker-v1` exists but can't be parsed or migrated, `load()` starts from `freshState()` but sets `loadFailed = { message, raw }`, and `save()` writes nothing while it's set — so the stored data is never overwritten by an empty state. The banner offers **Download raw saved data** (`downloadUnreadableData()`) and **Discard and resume saving** (`discardUnreadableData()`, confirm-gated). `clearAllDataCore()` also clears `loadFailed`. A blocked-storage *read* isn't treated this way; there's nothing stored to protect.

---

## Merging rankings between devices

Both sync transports — file export/import and Firestore — end in the same function, `mergeImport(incoming, opts)`. It's an **unconditional union by id**: every match and tombstone is a permanent, individually-identified fact, nothing is ever overwritten or compacted, so there's no "which side is ahead" question, no conflict to resolve, and no prompt. Merging the same payload twice is a no-op, and push/pull order never matters.

`mergeImport()` does, in order:

1. **Item tombstones.** Union `itemDeletes`/`itemUndeletes` (one entry per id, latest `ts` wins — `latestPerItemId()`). For each currently-tombstoned id this device still holds: if the tombstone is a rename, move the local copy to the id it resolves to (`makeIdResolver()` → `moveOrMergeItem()`); otherwise delete it. Local `matchLog` ids are resolved through renames too. See "Item deletions" and "Item renames".
2. **Category tombstones.** Union `catDeletes`/`catUndeletes`; purge any tombstoned category's name, schema, and remaining items. See "Category deletions".
3. **Local items onto this device's id scheme** (`rekeyOffSchemaItems()`, 2.18.5). Any item this device holds under an id computed from a *subset* of its category's identity fields moves to its full id by `localIdFor()`'s rule, recorded as a rename (a `renamedTo` tombstone, like a toggle's rekey) and merged with `moveOrMergeItem()` if a copy is already there. Without this, step 4 moved only the incoming copy and the item ended up twice.
4. **Schema, then items** (`unionItemsAndSchema()`). Schema is adopted *first* — a newly-synced identity flag rekeys local items (see "Item identity fields"), and doing that before comparing items is what lets incoming ids line up with local ones. Then items:
   - each incoming item is first moved onto this device's id scheme (`localIdFor()`, 2.18.4): an id computed from a *subset* of the category's identity fields (e.g. title alone, from before Year was flagged) becomes the item's full id, and the payload's matches follow it. Refining a key can only split items apart, so this never merges two different items; an id computed from *more* identity fields than this device has (an adoption skipped over a collision) is left alone. An item is skipped if either its incoming or its local id is tombstoned;
   - an id this device doesn't have is added, with `elo`/`wins`/`losses` defaulting to 1000/0/0 when the payload carries none (Firestore item docs never do), `hidden: false`, and skipped if tombstoned (itself or its category);
   - an id both sides have takes the incoming `title` and `fields` if its `updatedAt` is newer (last-write-wins on the whole edit). Ratings are never taken from the incoming side for an existing item.
   - Items created here *with* a rating in the payload are returned as `freshlySeeded`.
   - On a Firestore pull, `routeStoredRatings()` first decides where each reset-stored rating belongs now (2.18.1) — see "Resetting the shared baseline".
5. **Matches.** Incoming matches not already in the local `matchLog` have their ids moved with step 4's items and resolved through renames, then `applyNewMatches()` sorts them by `(ts, seq)` and applies each onto the live ratings with the same `eloUpdate()` a real vote uses. All of them are recorded in `matchLog`.

**Never re-applying what a payload already includes (`freshlySeeded`).** A file export's items and its `matchLog` are two views of the same moment, so a freshly-seeded item's rating already includes every match in that file touching it. For a **file** merge, `applyNewMatches(newMatches, freshlySeeded)` therefore:
- skips a match whose sides are both freshly seeded (recorded, not applied);
- for a match with exactly one freshly-seeded side, updates only the other side (2.16.2) — `eloUpdate()` runs on throwaway copies and only the non-seeded side's result is kept, with W/L exact and the ELO delta measured against the seeded item's current rating;
- applies everything else normally.

For a **cloud** merge (`{ cloudOrigin: true }`, set only by `pullFromFirestore()`) every match is applied to both sides. A Firestore item doc only carries a rating after a baseline reseed, and a reseed wipes the matches collection at the same moment, so nothing Firestore delivers can already be reflected in a baked-in rating.

**Why deltas on top of live ratings, not replay-from-scratch.** A from-scratch replay (reset everything to 1000, replay the whole `matchLog`) looks more deterministic, but it assumes `matchLog` is a complete history — false for any device carrying pre-v6 data, whose earlier history exists only inside `item.elo`/`wins`/`losses`. Applying only new deltas has no such assumption. It's also why the pre-2.0.0 snapshot/baseline design was replaced: classifying how two snapshots relate before merging produced three bugs in a row, and the union model has no classification step to get wrong. (Design notes for the discarded approaches are kept locally, untracked, in `log/archive/`.)

**Accepted consequence:** match order across two devices isn't globally reconstructed — see "Known gaps in the merge model".

`hidden` never travels in either direction: exports strip it, and newly-adopted items get `hidden: false`.

### Item deletions

Deleting an item is a synced fact, not a local mutation. `deleteItem(id)` and `deleteItemsInCat(cat)` remove the item(s) and append a tombstone `{ itemId, ts, deviceId, title, cat }` to `state.itemDeletes`; `mergeImport()` removes a tombstoned item on every other device before unioning items in, so a stale copy can't resurrect it. Field edits are *not* tracked this way — they stay last-write-wins, since only deletion had a real resurrection failure mode.

**Undelete (2.2.0).** Ids are deterministic, so re-creating a deleted title computes the same id — and an unconditional tombstone would block it forever. Tombstones are therefore resolved against a parallel `state.itemUndeletes` log:

- `latestPerItemId()` keeps only the latest entry per id in each log, so any number of delete/undelete cycles need no unique event ids.
- `currentlyTombstonedIds(deletes, undeletes)`: an id is tombstoned iff its latest delete is newer than its latest undelete. **Ties favor deleted.** Every undelete is therefore timestamped strictly after the delete it answers (`Math.max(Date.now(), tombstone.ts + 1)`).
- **Manual:** Data tab → Deleted items → Undelete (`undeleteItem()`). It only clears the sync block; it does **not** restore the old item's data or rating (the UI says so).
- **Automatic (2.17.1):** every path that creates an item — `addItem()`, `bulkAddCSVImport()`, `applyCSVImport()` (CSV create/replace), and a rename back in `saveItem()` — calls `undeleteIfTombstoned(id, title, cat)`, which records an undelete only if this device currently has that id tombstoned. It deliberately doesn't record one on every add (that would mean a record plus a Firestore write for every item ever created); the cost is that re-adding a title while the other device's delete of it hasn't been pulled yet still loses to that delete.
- **Deleted Items view:** `renderDeletedItems()` lists currently-tombstoned items (excluding renames), capped to the latest `DELETED_ITEMS_PAGE_SIZE` (50) with a Show all toggle. The tombstone log itself is never capped — a tombstone must persist for "deletion wins" to hold.

**Known limitation:** a delete never undoes the ELO an item already applied to its opponents. If a delete and a match against that item reach a third device in the same merge, the match is skipped there (the item is gone), so that opponent's W/L can differ by one between devices.

### Item renames

*(2.17.0)* An item's id comes from its title (plus identity values), so renaming a single item moves it to a new id. That move syncs as an ordinary `itemDeletes` tombstone for the **old** id with one extra, optional field: `renamedTo: newId`. There's no separate rename log; a tombstone without `renamedTo` is a plain delete.

- **Renaming device (`saveItem()`):** moves the item with `remapItemIds({ [oldId]: newId }, { tombstones: false })` so its `matchLog`/`history` follow (Undo keeps working); undeletes `newId` if it was tombstoned (a rename back, via `undeleteIfTombstoned()`); then pushes the rename tombstone, timestamped by `tsAfterUndeletes()` to beat any same-millisecond undelete. `tombstones: false` keeps earlier rename tombstones on their own old ids.
- **Receiving device (`mergeImport()` step 1):** `makeIdResolver()` follows `renamedTo` while an id is currently tombstoned and stops at the first live id. Only each id's latest tombstone counts, so a delete after a rename wins, and a rename back can't loop (its target was undeleted). The local copy is moved with `moveOrMergeItem()`, keeping *this device's* rating, matches, and history; it picks up the new title from the incoming item doc via last-write-wins.
- **Collisions:** if the receiver already has an item at the target id (it separately added that title), the two entries are merged — W/L summed, rating from the entry with more matches (tie: the existing one's), title/fields last-write-wins, `hidden` from the existing one. A match between the two merged entries becomes a self-match, which `applyNewMatches()` skips.
- **Late votes:** a match recorded against an old id (by a device that hadn't heard of the rename) resolves to the renamed item, whether incoming or already in the local `matchLog`.
- Rename tombstones are hidden from Deleted Items. Firestore stores `renamedTo` on the `itemDeletes` doc (`null` for plain deletes); older app versions ignore it and see a plain delete — and if one re-uploads the tombstone, the doc loses `renamedTo`. Both devices should run 2.17.0+.
- Bulk rekeys from identity-flag changes are *not* renames: they push plain tombstones, and receivers recompute the new ids themselves from the adopted schema.

### Category deletions

*(2.5.0)* `confirmDeleteCat()` removes the category locally, tombstones each of its items (`deleteItemsInCat()`), and pushes `{ cat, ts, deviceId }` to `state.catDeletes`. On merge, `latestPerCat()`/`currentlyTombstonedCats()` resolve category tombstones the same way as items, and a tombstoned category's name, schema, and any remaining items are purged — including an item another device added to it concurrently, which has no tombstone of its own. `unionItemsAndSchema()` also skips incoming cats/schema/items for tombstoned categories.

There's no Undelete button for categories: there's nothing to restore (deleting a category wipes its items and schema). Instead, **creating** a category always records a category undelete (`undeleteCategory()`, called by `saveNewCat()` and by a CSV import that creates a category), timestamped after any known delete of that name — so a (re)created name always syncs.

Firestore doc ids for category tombstones are `catKey(cat)` (same hash as `itemKey()`, `'c'` prefix), since raw names can contain characters doc ids reject; the real name is stored in the doc.

### Item identity fields

*(2.1.0)* Lets two items in a category share a title, distinguished by another field — e.g. two "Dune" movies by Year.

- A schema field can be flagged `identity: true` in the Schema Editor (`toggleIdentity(i)`); this forces `required`.
- `identitySuffixForFields(idFields, fields)` builds a suffix from the identity fields, sorted by name, values normalized like titles (`trim().toLowerCase()`); `identitySuffixFor(cat, fields)` reads the saved schema. `itemKey(cat, title, suffix)` folds it into the hash; with no identity fields the suffix is `''` and ids are unchanged.
- Every id-computing call site goes through these helpers — there is no second notion of "same item" (a separate title-only lookup is exactly what once let a CSV import overwrite the wrong "Dune").
- **Editing an identity value is a rename**, handled exactly like a title rename (see "Item renames").
- **Toggling identity on an existing category** is a bulk rekey in `saveSchema()` via `rekeyItemsForIdentityFields(cat, pendingIdFields)`: it computes every item's new id and, if no two *different* items (compared by original id, not title) collide, applies it with `remapItemIds(idMap, { tombstones: false })` — items, `matchLog`, `history` — and gives moved items a fresh `updatedAt`. Each moved item is then recorded as a **rename**, exactly like `saveItem()`'s: a tombstone on the old id with `renamedTo` the new id, and an undelete of the new id if it's tombstoned (2.18.2). Other devices move their own copies (keeping their ratings), old matches resolve to the new ids, a reset's stored ratings follow, and the items stay off Deleted Items. Before 2.18.2 the old ids got plain deletes, so every other device deleted its copies and re-created them from the pulled docs at 1000/0-0, and a device joining later couldn't replay any earlier match; and existing tombstones were rewritten onto the new ids without their undeletes, so an item that had been deleted and re-added was deleted by the next merge. On a collision (only possible when *removing* a disambiguating flag) the save is blocked with a toast naming both items.
- **Sync:** for a category both sides know, `adoptIncomingFields()` adopts any field this device has never heard of, and any `identity: true` it doesn't have yet — monotonic, never turning identity off. An identity adoption goes through the same `rekeyItemsForIdentityFields()` and is skipped (with a `console.warn`) on a collision rather than half-applied. `required`/`filterable` on an already-shared field stay local-only.
- Because schema is adopted before items are unioned (merge step 4), a device whose identity flags were behind rekeys its items onto the same scheme before comparing, so nothing duplicates.
- The other direction: a device whose flags are *ahead* moves each incoming item keyed under the older scheme onto its full id (`localIdFor()`, 2.18.4). This matters when the device has no copy to match against — e.g. it cleared its items, turned a flag on, then ran Reset, whose first pull returns every cloud doc under its old id.
- The same applies to this device's *own* items (`rekeyOffSchemaItems()`, 2.18.5): any merge first moves local items keyed under the older scheme onto their full ids, as renames, so a device left off-schema (flag on, items under old ids — e.g. by a Reset under 2.18.3) repairs itself on its next pull, merging any duplicates the 2.18.4 pull created.

### Multi-value fields

*(2.14.0)* A field flagged `multi: true` (`toggleMulti(i)`) holds several comma-separated values ("Pop, Rock") and filters on each one.

- Storage is still one string; `normalizeFieldValue(f, raw)` (used by `addItem()`/`saveItem()`) splits, trims, dedupes, and rejoins with `", "`.
- `multi` never affects ids or `required`.
- `fieldFilterType()` resolves a multi field to `'multi'` (skipping numeric inference); its filter pills are the individual tokens, and `getFilteredItems()` matches if *any* of an item's tokens is selected.

---

## Cloud sync (Firestore)

An optional second transport next to file export/import — both feed `mergeImport()`. The Data tab's Cloud sync card adds Google sign-in and Upload/Pull buttons. Neither transport is real-time; both sync when someone clicks.

**Why Firestore:** the merge already runs client-side, so the backend only needs to store and serve documents to authorized users. Firestore's free tier does that with no server code, and its security rules give real per-user access control.

### Layout: one document per fact

- `rankers/shared` — root doc: `{ cats, schema, updatedAt, updatedBy, baselineId? }`
- `rankers/shared/items/{itemId}` — `{ cat, title, fields, updatedAt, syncedAt }`. **No ratings.** Ratings live only in each device's local state, kept current by applying matches; `unionItemsAndSchema()` therefore defaults new items to 1000/0/0. (Exception: a baseline reseed bakes ratings in — see below. Ordinary uploads write with `mergeFields`, so a baked rating stays on the doc through later edits, 2.18.1.)
- `rankers/shared/matches/{matchId}` — `{ cat, wid, lid, ts, seq, syncedAt }`
- `rankers/shared/itemDeletes/{itemId}` — `{ itemId, ts, deviceId, title, cat, renamedTo, syncedAt }`, mapped both ways by `tombstoneDoc()`/`tombstoneFromDoc()`. `title`/`cat`/`renamedTo` are written as `null` when absent — Firestore rejects `undefined` field values.
- `rankers/shared/itemUndeletes/{itemId}` — same shape, without `renamedTo`
- `rankers/shared/catDeletes/{catKey(cat)}`, `rankers/shared/catUndeletes/{catKey(cat)}` — `{ cat, ts, deviceId, syncedAt }`

Every doc id is the fact's own id, so writing a fact twice is an idempotent overwrite — which is why push and pull can happen in any order, from either device. A later delete of the same item overwrites its tombstone doc, matching the latest-ts-per-id model. `syncedAt` is a server timestamp used only as the pull cursor; `updatedAt`/`ts` are client timestamps used for the data itself.

### Upload and pull

- **`uploadToFirestore()`** writes item docs with `set(…, { mergeFields: ['cat', 'title', 'fields', 'updatedAt', 'syncedAt'] })` (2.18.1), so it never erases a rating a reset stored there. It pushes only what this device hasn't pushed, tracked by the `settings.lastUploaded*` cursors: items with a newer `updatedAt`, this device's own matches (by `deviceId` prefix and `seq`), and newer tombstones/undeletes. Writes are committed in batches of at most 500 (Firestore's hard per-batch limit, 2.0.4), then the root doc's cats/schema; cursors advance only once everything succeeds, so an interrupted upload simply re-sends next time.
- **`pullFromFirestore()`** fetches docs with `syncedAt` newer than `state.lastSyncedServerTs` from all six subcollections (everything, on a device that's never pulled), builds an `incoming` payload, calls `mergeImport(incoming, { cloudOrigin: true })`, advances the cursor, and records the root doc's `baselineId` in `settings.knownBaselineId`. **Pulling into an empty library** (no items, matches, or tombstones — after Adopt's clear, or on a brand-new device) also moves the `lastUploaded*` cursors past everything it pulled (2.18.3): it's all already in the cloud, and with every cursor at 0 the next Upload used to re-send every item and tombstone (identical rewrites, but one write each, and a re-read on every other device's next pull). These are the values that redundant Upload used to leave them at. A non-empty device's cursors are never touched, since it may have unsent work. `{ full: true }` ignores the cursor (used by recovery); a full pull never rewinds the cursor.

### Auth, hosting, and setup

- **Setup:** create a Firebase project with Firestore and the Google sign-in provider; register a Web app for the `firebaseConfig`; have both users sign in once to get their UIDs; publish the security rules below. (Longer walkthroughs are kept locally in the gitignored `log/`.)
- **Must be served over http(s).** `signInWithPopup()` fails on `file://`; a local static server (`npx serve .`) works, and `localhost` is authorized by default. Any hosting domain (e.g. `<user>.github.io`) must be added under Firebase Console → Authentication → Settings → Authorized domains.
- **Loaded via CDN**, not npm: the Firebase compat SDK exposes a global `firebase`, so there's still no build step.
- **`firebaseConfig` is committed on purpose.** It isn't a secret; the security rules are the gate.
- **Defensive init:** initialization is wrapped in `try/catch` so a blocked CDN or bad config can't halt the rest of the script; `cloudAvailable` records the outcome.
- **Signed-out UI (2.10.0):** `renderCloudAuthUI()` hides (not just disables) Upload/Pull (`#cloud-sync-actions`) and the whole Baseline recovery card (`#baseline-recovery-card`) until a sign-in succeeds; every cloud function also bails without a signed-in user.

### Resetting the shared baseline

*(2.9.0)* For when sync has drifted and isn't worth untangling fact by fact: make one device's view the new shared truth, in two clicks. Both users can do this — the security rules give both full access to `rankers/shared`, and deliberately no owner/admin distinction.

**Upload from every device before anyone resets** — anything a device never uploaded is lost (see the table below).

1. **On the device you trust (User A): Data → Baseline recovery → "⚠ Reset shared baseline"** (`resetSharedBaseline()`, confirm-gated). It:
   - does a full pull, so anything only in Firestore is absorbed;
   - clears all four tombstone logs on the live local state;
   - downloads `ranker-pre-reset-backup.json` as an offline safety net;
   - wipes Firestore (`wipeFirestoreCollections()`), resets the upload cursors;
   - reseeds with `uploadToFirestore({ full: true })`: **ratings baked into every item doc, an empty matches collection, no tombstones**, and a fresh random `baselineId` on the root doc.

   Every step after the confirm is safely re-runnable if interrupted.
2. **On every other device: "↓ Adopt fresh baseline"** (`adoptFreshBaseline()`). It clears local state (`clearAllDataCore()`) and pulls the reseed, so every item takes the baked rating (the "no local copy" path) and any match ranked after the reset applies normally on top. It preserves this device's own hidden-item markings (2.13.0) by re-applying them to ids that still exist. A plain Pull is *not* equivalent: an item the device already has never adopts an incoming rating.

**Working after a reset (2.18.1).** The stored ratings must survive whatever happens before another device adopts:
- **Edits** (Library edit form, CSV bulk add): ordinary uploads write only `cat`/`title`/`fields`/`updatedAt`/`syncedAt` (`mergeFields`), leaving the stored rating on the doc. Before 2.18.1 they replaced the whole doc, so an edited item reached a later-adopting device at 1000 plus its post-reset votes, its pre-reset history gone.
- **Renames and deletes:** the stored rating stays on the old id's doc, so on a pull `routeStoredRatings()` uses each item's latest tombstone (all of them are newer than the reset): no tombstone keeps it; a plain delete drops it, so a re-added title or a CSV Replace starts fresh, as on the device that did it; a rename sends it along the `renamedTo` chain (possibly back to the same id), joining any rating already stored there by `moveOrMergeItem()`'s rule.

Pinned end to end by `tests/reset-baseline.test.js`.

**Baseline-id guard (2.12.0).** An ordinary Upload first reads the root doc; if it has a `baselineId` this device hasn't seen (`settings.knownBaselineId`), the upload is refused with a toast pointing at Adopt — so a device that missed a reset can't push stale data onto the new baseline. A root doc with no `baselineId` (never reset) skips the check entirely; a `full` reseed is exempt.

**What survives:**

| | Device running Reset | Devices running Adopt |
|---|---|---|
| Items + ratings | Kept; reseeded with ratings baked in | Wiped, then adopted from the reseed |
| `matchLog` | Kept locally; Firestore reseeded **empty** (the baked ratings already include every match) | Wiped; only post-reset matches appear |
| Tombstones (all four logs) | **Dropped** (deliberately — see below) | Dropped |
| `cats`/`schema` | Kept; reseeded | Wiped, then pulled back |
| Undo history (`state.history`) | Kept | **Lost** (never synced) |
| Hidden markings | Kept | Restored for ids that still exist |
| Upload/pull cursors | Reset, then advanced by the reseed | Reset, then set by the pull — upload cursors included, so the next Upload sends nothing (2.18.3) |
| Local work never uploaded | **Lost** — the pre-reset pull can't see it | **Lost** — the clear runs before the pull |

**Dropping tombstones is deliberate.** A reset means starting clean, past deletions included. The cost: a device that was offline through a delete, never adopted the reset, and uploads its stale copy would resurrect that item as new. The baseline-id guard blocks the ordinary Upload that would cause this, so it now requires bypassing the guard; it also means a reset clears any tombstone that was blocking a re-sync.

**Deleting a category and resetting:** a local, not-yet-uploaded category delete is enough to exclude that category from the reseed — but it also discards anything *another* device added to that category and uploaded before the reset (the tombstone can't tell stale data from new). **Pull, then delete, then Reset.**

**Offline fallback:** `exportRecoveryBaseline()` (2.8.0) does a full pull merged onto this device and downloads the same compacted baseline file (`matchLogCompacted: true`) without touching Firestore. Importing such a file into a non-empty library triggers a warning, since it can only correctly *replace* an empty one.

### Limitations

- A device's first pull (or a pull after `lastSyncedServerTs` is reset) reads every doc ever written, against Firestore's free-tier limit of about 50,000 reads/day. Fine at this app's scale; the baseline reset bounds it.
- `cloudSyncTimes` (last upload/pull shown in the card) is in-memory only.

### Security rules

Maintained by hand in Firebase Console → Firestore Database → Rules (a code change doesn't update them). New subcollections need adding here.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rankers/shared {
      allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      match /items/{itemId}         { allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>']; }
      match /matches/{matchId}      { allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>']; }
      match /itemDeletes/{itemId}   { allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>']; }
      match /itemUndeletes/{itemId} { allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>']; }
      match /catDeletes/{catId}     { allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>']; }
      match /catUndeletes/{catId}   { allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>']; }
    }
  }
}
```

### Known gaps in the merge model

Accepted tradeoffs — none lose items or matches:

- **Match order across devices isn't globally reconstructed.** New matches are applied on top of whatever each device's ratings are at merge time, and clocks can disagree (`seq` only orders one device's own matches). Every match counts exactly once, but two devices' ELO for an item can drift apart by a few points. W/L counts agree.
- **Field edits are last-write-wins per item, not per field.** If both devices edit *different* fields of the same item between syncs, the older edit is lost entirely.
- **Merged rename collisions** can leave slightly different ELO on each device (W/L agree) — see "Item renames".
- **A match against a since-deleted item** can leave its opponent's W/L off by one between devices — see "Item deletions".
- **Re-adding a title while the other device's delete of it is unpulled** loses to that delete — see "Item deletions".
- **Upload only sends this device's own work, so data imported from another device's file never reaches Firestore from here.** Matches are pushed only if their id carries this device's `deviceId` prefix, and items only if their `updatedAt` is newer than this device's upload cursor — imported items keep the originating device's older `updatedAt`. So importing a file from a device that can't sync itself, then clicking Upload, silently pushes none of its matches and possibly none of its items (it all stays in this device's local state). To get it into Firestore, upload from the originating device, or run "Reset shared baseline" from the importing device — the reseed pushes everything, with ratings baked in. Found during the Aug 2026 manual reseed.
- **Pulled changes echo back on the next Upload.** Upload sends whatever is newer than this device's cursors, so an edit or tombstone pulled from another device is re-sent by this device's next Upload — an identical rewrite (one write, and a re-read on the other device). Only pulls into an empty library avoid it (2.18.3); avoiding it everywhere would mean tracking which changes were made locally, per item. Harmless, and small at this app's scale.
- **A stored rating can follow the wrong rename in one rare sequence.** After a reset, renaming an item away, re-adding a new item under its old title, then renaming *that* one too: Firestore keeps only the latest tombstone per id, so a device adopting afterwards sends the original stored rating along the second rename instead of the first. Needs all three steps between a reset and the adopt.
- **Turning an identity field *off* doesn't sync the flag, but does sync the moves.** Other devices never adopt identity being turned off (see "Item identity fields"), yet since 2.18.2 the rekey's rename tombstones still move their copies to the shorter ids. Ratings are kept, but those devices' ids no longer match their own schema until they turn the flag off too; an edit there recomputes the id and is treated as a rename.
- **`settings.userName`** is reserved (added with `deviceId` in schema v4) but unused and stripped from exports.

---

## ELO ranking

Standard ELO with K = 32 (`eloUpdate()`), rounded to integers:

```js
const E = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
winner.elo = Math.round(winner.elo + 32 * (1 - E));
loser.elo  = Math.round(loser.elo  + 32 * (0 - 1 + E));
winner.wins++; loser.losses++;
```

All items start at 1000. The leaderboard's score bar is normalized: top item 100%, bottom 0%.

`applyEloUpdate()` wraps it and returns the `{ wid, lid, wChange, lChange }` delta used for history/undo; `recordMatch()` appends the result to `matchLog`.

## Ranking modes

ELO and W/L are hidden while ranking (to avoid anchoring) and shown in the Library and Leaderboard. The mode is saved per device in `settings.rankMode` (2.16.1). All modes draw from `itemsForCat()` — the active filters applied, hidden items excluded.

- **1 vs 1** (`loadPair()`, `vote()`): two items, pick one — one ELO update. Keyboard voting via `handleRankVoteKey()`: `←`/`1` and `→`/`2`, only when the Rank tab is active in 1v1 mode and focus isn't in a text field. `standardSessionVotes` counts votes since the category was last selected (in memory only).
- **Podium** (`loadPodium()`, `submitPodium()`): 3–5 items; assign 🥇🥈🥉. Each placed item beats every lower-placed and unplaced item; unplaced items aren't compared. Up to 9 updates per round.
- **Tier** (`loadTier()`, `submitTier()`): 3–30 items (chosen per session) sorted into S/A/B/C/D; every cross-tier pair is an update (up to 45 for 10 items). The pool (`startTierSession()`) takes never-ranked items first (up to half the session), fills the rest from ranked items — a random ELO window of them with Smart pairing — and tops up from whatever is left, so a session always has exactly the size asked for (2.17.3). No skip button.

**Smart pairing** (toggle, saved in `settings.smartPairMode`): instead of random selection —
- 1v1: `smartPair()` picks a random anchor and pairs it with the single closest-ELO item;
- Podium (≥ 5 items): a random contiguous window of the ELO-sorted list;
- Tier: after priority items, a random ELO-sorted window of `n + 2` items.

Without it, `randomPair()` picks two independent random items (so the same pair can repeat, and lopsided matchups teach little).

**Adding a mode:** add a button to `.mode-toggle`, a branch in `setRankMode()`/`applyRankModeUI()`/`initRankView()`, and a `load*()` that renders into `#rank-pair`; record every implied pairwise result with `applyEloUpdate()` + `recordMatch()`.

## Undo

The History tab (`renderHistory()`) shows the last 50 rankings; `undoRanking()` reverses an entry's ELO/W/L changes and removes its matches from `matchLog`. `canUndo()` refuses an undo up front if any item the entry touches no longer exists (a disabled "Undo unavailable" button), rather than reversing only part of it. Deleted items are handled separately, by Undelete (see "Item deletions").

---

## Event wiring

*(2.17.2)* There are no inline `on*=` handlers. Controls declare what they do with `data-*` attributes, and one document-level listener per event type (`delegate()`) calls the named global function (`runDataHandler()`):

| Attribute | Fires on |
|---|---|
| `data-action="fn"` | click |
| `data-change="fn"` | change |
| `data-keyup="fn"` | keyup |
| `data-enter="fn"` / `data-escape="fn"` | keydown Enter / Escape |

- **Arguments:** `data-args` holds a JSON array — always built with `argsAttr(...args)`, which escapes it for the attribute, so user text (a category name with quotes or apostrophes) arrives intact. `data-pass="el" | "checked" | "event"` passes the element, its `checked` state, or the event instead; it's a separate attribute so no user-supplied argument can ever be mistaken for one of these.
- **Lookup by name at event time** (`window[name]`) keeps markup and code decoupled — and lets the click tests stub a function by name.
- **Only the innermost element** carrying the attribute acts, so a button inside a clickable panel header (the filter panel's ✕ Clear) doesn't also toggle the header — no `stopPropagation()` needed.
- A link (`<a>`) with a `data-action` never navigates; `data-keep-focus` makes mousedown leave focus where it is (the search ✕ button).
- Inline code that used to be several statements lives in small named functions: `onLibCatChange()`, `onRankCatChange()`, `toggleFilterPanel()`, `selectLBCat()`, `showAllLBRows()`, `toggleDeletedItemsShowAll()`.
- **Adding a control:** give it the right attribute and `argsAttr(...)`, and make sure the function is a top-level `function` declaration (so it's on `window`). Add a test to `tests/ui.test.js` that finds it by id, text, aria-label, or title.

## Tab views

| Tab | View ID | Key functions |
|---|---|---|
| Library | `view-library` | `renderLibrary()`, `renderAddForm()`, `addItem()`, `editItem()`, `saveItem()`, `deleteItem()`, `toggleHidden()`, `bulkSetHidden()` |
| New Category | `view-newcat` | `openNewCatModal()`, `saveNewCat()`, `addNewCatField()` |
| Schema Editor | `view-schema` | `openSchemaEditor()`, `saveSchema()`, `addSchemaField()`, `confirmDeleteCat()` |
| Rank | `view-rank` | `initRankView()`, `setRankMode()`, `loadPair()`, `vote()`, `loadPodium()`, `submitPodium()`, `loadTier()`, `submitTier()` |
| Leaderboard | `view-leaderboard` | `renderLB()`, `appendLBRows()`, `lbRowHtml()` |
| History | `view-history` | `renderHistory()`, `undoRanking()` |
| Data | `view-data` | `exportData()`, `importData()`, `importCSV()`, `uploadToFirestore()`, `pullFromFirestore()`, `renderStats()`, `renderDeletedItems()`, `undeleteItem()`, `clearAllData()` |

`switchTab(id)` toggles `.active` on the nav buttons and view divs, and renders the entered view. New Category and Schema Editor have no nav tab; they're entered programmatically and return to the Library.

Category pickers — the Library and Rank dropdowns (`rebuildCatSelects()`) and the Leaderboard pills — list categories alphabetically via `sortedCats()` (2.18.0): case-insensitive, numbers in numeric order ("Top 2" before "Top 10"). This is display-only; `state.cats` keeps creation order.

### Library

- **Search** (`#lib-search`): case-insensitive substring match on the title and every field value; cleared, along with filters, when the category changes. A "✕" button (`#lib-search-clear`, `clearLibSearch()`) shows while there's text. Two CSS details keep that button from moving under the cursor: `html { overflow-y: scroll; }` reserves the scrollbar gutter so the page width never changes, and the button is centred with `margin: auto` rather than `transform` (which `button:active`'s press effect would override).
- **Pagination** (2.6.0): `renderLibrary()` renders one `LIB_PAGE_SIZE` (50) page of `filteredLibraryList()` (search + filters over the whole category), with Prev/Next. A fingerprint of `(cat, query, filterState[cat])` resets to page 1 when it changes; the page is clamped when the list shrinks.
- **Hiding** (`hidden`): the ◎/◉ button (`toggleHidden()`) excludes an item from ranking and the Leaderboard (`itemsForCat()`), while the Library (`libItems()`) keeps showing it, dimmed. The bulk toolbar applies `bulkSetHidden()` to every item in `filteredLibraryList()`, across all pages. `hidden` is a per-device preference: stripped from exports, forced `false` on import, never synced.
- **Inline editing:** `editItem()` expands a row; `saveItem()` validates, normalizes, and saves. Saving with nothing changed toasts "No changes" without bumping `updatedAt`; a title/identity change is a rename (see "Item renames").

### Leaderboard

*(2.16.0)* Infinite scroll rather than pages, since a ranking is read top-down.

- `renderLB()` sorts the filtered list into `lbList` and renders the first `lbShown` rows (`LB_BATCH` = 50), followed by a footer holding an invisible sentinel, "Showing N of M", and **Show all**.
- An `IntersectionObserver` (400px below the viewport) calls `appendLBRows(LB_BATCH)` as the sentinel nears the screen, adding rows with `insertAdjacentHTML` rather than rebuilding. The sentinel is recreated after every append, and observing a new element always fires once, so tall screens keep loading until it's off-screen.
- `lbShown` survives re-renders (votes, syncs, edits don't jump back to the top) and resets only when `(lbCat, activeFilterKey(lbCat))` changes. `activeFilterKey()` ignores the inert placeholder entries the filter UI creates.
- **`renderLB()` does nothing while its tab is hidden** — it's called after every vote/edit/sync — and `switchTab('leaderboard')` re-renders on entry.
- Score bars are relative to the whole list's range. Browser find only sees loaded rows; Show all loads everything.

### Field filtering

Items are filtered by their extra fields in the Library, Leaderboard, and every rank mode — everything goes through `getFilteredItems(cat, items, filterState)`, so there's one filtering implementation.

- **State:** `filterState[cat][field] = { type, values, min, max, equals, nonBlank }`; `filterCollapsed[cat]` (collapsed by default). Filters aren't persisted, and reset when the category changes.
- **Types:** `fieldFilterType()` returns `'multi'` for multi fields, else `inferFieldType()`: `'number'` if ≥ 80% of up to 20 sampled values parse as numbers, else `'string'`. Results are cached in `fieldTypeCache`, invalidated per category whenever its items change (`invalidateFieldTypeCache()`). Since a field's type can change within a session, `filterEntry(cat, field)` re-creates a field's `filterState` entry whenever its type no longer matches (2.17.3) — conditions set for the old type are dropped, since a min on a text field or text values on a number field mean nothing.
- **Matching** (AND across fields): numbers use min/max/equals; strings match selected values exactly; multi fields match if any token is selected; "Has value" (`nonBlank`, any type) excludes blanks. A field with no active condition is ignored. `filterNarrows()` is the single definition of "active", shared by the filter panel's count/Clear button and `activeFilterKey()`.
- **UI:** `renderFilterUI(cat)` builds the cards once (`buildFilterFieldCards()`, skipping `filterable: false` fields) and renders them into both `#lib-filters` and `#rank-filters` via `buildFilterPanel()`. `updateFilter(el)` handles input changes; `clearAllFilters()`/`resetFilters()` clear. The panel header carries `data-cat`; the Clear button passes the category through `argsAttr()` (see "Event wiring").
- **Schema flags** set in the Fields editor: `filterable` (🔍), `identity`, `multi` (🏷️).

---

## Key functions

One line each; the sections above have the details.

**Persistence & state**

| Function | What it does |
|---|---|
| `freshState()` | A new empty `state`, including a fresh `deviceId` |
| `load()` | Reads localStorage, `migrateData()`, restores settings, renders; sets `loadFailed` on unreadable data |
| `save()` / `renderSaveWarning()` | Writes state; shows the save-failure / near-full / unreadable-data banner |
| `downloadUnreadableData()` / `discardUnreadableData()` | Recovery actions for `loadFailed` |
| `migrateData(data)` | Applies every schema migration in order; backfills optional fields |
| `clearAllData()` / `clearAllDataCore()` | Confirm + reset to `freshState()` and clear storage / the reset itself |
| `renderStats()` | Data tab version, storage-usage, and count rows |

**Items, schema, categories**

| Function | What it does |
|---|---|
| `itemKey(cat, title, suffix)` / `catKey(cat)` | Deterministic item id / category doc id |
| `identitySuffixFor(cat, fields)` / `identitySuffixForFields(idFields, fields)` | `itemKey()`'s identity suffix |
| `schemaFor()` / `primaryLabel()` / `extraFields()` | Schema accessors with defaults |
| `ensureSchemaWellFormed()` | Gives every category a valid `{ primary, fields }` |
| `addItem()` / `saveItem(id)` / `deleteItem(id)` | Add / edit (rename-aware) / delete with tombstone |
| `fieldsEqual(a, b)` | Value comparison that skips no-op `updatedAt` bumps |
| `normalizeFieldValue(f, raw)` | Multi-field token cleanup |
| `undeleteIfTombstoned(id, title, cat, tombstoned?)` | Auto-undelete when an item is (re)created on a tombstoned id |
| `saveNewCat()` / `undeleteCategory(name)` | Create a category / record its undelete |
| `saveSchema()` / `rekeyItemsForIdentityFields(cat, idFields)` | Save schema / bulk identity rekey with collision check |
| `confirmDeleteCat()` / `deleteItemsInCat(cat)` | Delete a category (with its tombstone) / tombstone all its items |
| `remapItemIds(idMap, { tombstones })` | Rekey items, `matchLog`, `history` (and tombstones unless `false`) |
| `toggleHidden(id)` / `bulkSetHidden(hidden)` | Per-item / bulk hide |

**Library, filters, Leaderboard**

| Function | What it does |
|---|---|
| `renderLibrary()` / `filteredLibraryList()` / `libGoToPage(p)` / `clearLibSearch()` | Library list, its matching set, paging, search clear |
| `itemsForCat(cat)` / `libItems()` | Rank/Leaderboard pool (filtered, no hidden) / Library pool |
| `sortedCats(cats)` / `rebuildCatSelects()` | Categories in display (alphabetical) order / refill the Library and Rank dropdowns |
| `getFilteredItems(cat, items, filters)` / `filterNarrows(f)` / `activeFilterKey(cat)` | Apply filters / is a filter active / fingerprint of active filters |
| `filterEntry(cat, field)` | A field's `filterState` entry, re-created when the field's type has changed |
| `fieldFilterType()` / `inferFieldType()` / `invalidateFieldTypeCache(cat)` | Filter type resolution and its cache |
| `renderFilterUI(cat)` / `buildFilterFieldCards()` / `buildFilterPanel()` / `updateFilter(el)` / `clearAllFilters(cat)` / `resetFilters(cat)` | Filter UI |
| `renderLB()` / `appendLBRows(n)` / `lbRowHtml(item, idx)` | Leaderboard with infinite scroll |
| `itemMeta()` / `itemMetaInline()` / `itemMetaStacked()` | Field display helpers |

**Ranking & history**

| Function | What it does |
|---|---|
| `initRankView()` / `setRankMode(mode)` / `applyRankModeUI(mode)` | Rank tab entry, mode switch (saved), mode button state |
| `loadPair()` / `smartPair()` / `randomPair()` / `vote(wid, lid)` / `handleRankVoteKey(e)` | 1v1 |
| `loadPodium()` / `assignPlace()` / `clearPodiumPlace()` / `submitPodium()` | Podium |
| `loadTier()` / `startTierSession()` / `assignTier()` / `removeTierPlacement()` / `submitTier()` | Tier |
| `toggleSmartPair(on)` | Smart pairing toggle (saved) |
| `eloUpdate(w, l)` / `applyEloUpdate(w, l)` / `recordMatch(cat, wid, lid)` | ELO math / with delta record / append to `matchLog` |
| `recordRanking()` / `renderHistory()` / `canUndo(entry)` / `undoRanking(i)` | History and undo |

**Sync**

| Function | What it does |
|---|---|
| `buildExportPayload()` / `exportData()` / `importData(e)` | File export / import (→ `migrateData()` → `mergeImport()`) |
| `mergeImport(incoming, { cloudOrigin })` | The union merge — see "Merging rankings between devices" |
| `unionItemsAndSchema()` / `adoptIncomingFields(cat, fields)` | Merge step 3: schema then items; field/identity adoption |
| `localIdFor(item)` | Moves an incoming item keyed under a coarser identity scheme onto its full id (2.18.4) |
| `rekeyOffSchemaItems()` | Moves this device's own items keyed under a coarser identity scheme onto their full ids, as renames, merging duplicates (2.18.5) |
| `applyNewMatches(matches, seededIds)` | Apply new matches as deltas; one-sided for seeded items; skips self-matches |
| `makeIdResolver()` / `moveOrMergeItem(from, to)` | Follow renames / move or merge a renamed local copy |
| `routeStoredRatings(items)` | On a Firestore pull, move reset-stored ratings along renames and drop them after deletes |
| `latestByKey()` / `latestPerItemId()` / `latestPerCat()` | Latest tombstone per key |
| `currentlyTombstonedIds()` / `currentlyTombstonedCats()` | Delete-vs-undelete resolution (ties → deleted) |
| `undeleteItem(id)` / `renderDeletedItems()` / `tsAfterUndeletes(id)` | Manual undelete / Deleted Items view / tie-safe timestamp |
| `dedupeById(list)` | Dedupe `matchLog` entries |
| `cloudSignIn()` / `cloudSignOut()` / `renderCloudAuthUI()` / `cloudErrorMessage(e)` | Auth and Cloud sync card |
| `uploadToFirestore({ full })` / `pullFromFirestore({ full })` | Firestore push / pull |
| `tombstoneDoc(t)` / `tombstoneFromDoc(d)` | Tombstone ↔ Firestore doc |
| `resetSharedBaseline()` / `adoptFreshBaseline()` / `exportRecoveryBaseline()` | Baseline reset, adopt, offline fallback |
| `wipeFirestoreCollections()` / `deleteAllDocs(ref)` | Firestore wipe (reset only) |

**CSV and utilities**

| Function | What it does |
|---|---|
| `importCSV(e)` / `parsePreloadCSV(text)` / `splitCSVLine(line)` | Read and parse a preload CSV |
| `resolveCSVImport(result)` / `bulkAddCSVImport()` / `applyCSVImport()` | Bulk add / replace / create |
| `exportCategoryCSV()` / `csvCell(v)` | CSV export |
| `esc(s)` | HTML-escape for text and quoted attributes (including `"` and `'`) |
| `toast(msg)` / `switchTab(id)` / `uid()` / `makeDeviceId()` | UI and id utilities |
| `argsAttr(...args)` / `runDataHandler()` / `delegate()` | Event wiring — see "Event wiring" |
| `onLibCatChange()` / `onRankCatChange()` / `toggleFilterPanel(header)` / `selectLBCat(cat)` / `showAllLBRows()` / `toggleDeletedItemsShowAll()` | Small handlers for controls whose behaviour used to be inline code |

---

## Extending the app

- **Built-in category:** add an entry to `CAT_DEFAULTS` (every key is in `BUILTIN_CATS`, which protects it from deletion).
- **CSV directive** (e.g. `#description`): add a branch in `parsePreloadCSV()`, carry the value on its result, apply it in `applyCSVImport()`.
- **Hosting:** it's one static file — GitHub Pages, Netlify/Vercel, or Cloudflare Pages all work. Cloud sync then needs the domain authorized in Firebase (see "Auth, hosting, and setup").
- **A real backend:** replace `save()`/`load()` with `fetch()` calls; the state is already plain JSON.
- **A framework port:** `state` → a store, each `render*()` → a component, `save()`/`load()` → a store plugin. The app is intentionally framework-free.
- **More than two sync users** (deliberately out of scope): for a few more people, swap the hard-coded UID list in the rules for an allowlist collection (`exists(/databases/$(database)/documents/allowlist/$(request.auth.uid))`). Self-serve groups would need per-group documents, an invite flow, and per-group rules — a redesign of the sync layer, not an increment.

---

## Design decisions & tradeoffs

| Decision | Why | Alternative |
|---|---|---|
| Single HTML file, vanilla JS | Zero setup, trivially shareable, easy to read | Bundler + framework |
| localStorage | No server needed | IndexedDB (larger), backend |
| ELO scoring | Well understood, self-balancing | TrueSkill, win counts |
| Schema per category | User-defined fields | Hard-coded fields per type |
| Several ranking modes | Different speeds and batch sizes | One mode |
| ELO hidden while ranking | Avoids anchoring | Always visible |
| Inline editing | Edit without leaving the Library | Separate edit screen |
| History capped at 50 | Undo for recent mistakes without storage pressure | No undo, or unbounded |
| Hide vs. delete | Reversible exclusion that keeps ELO/history | Delete, or an archive tab |
| CSV import/export | Easy to author and share clean libraries | JSON only |
| Deterministic ids (`itemKey()` + identity fields) | Two devices agree on "the same" item with no coordination; identity fields keep that property for same-titled items | Random ids + matching at merge time; random disambiguators (would break the zero-coordination guarantee) |
| Append-only facts unioned by id, applied as deltas on live ratings | No snapshot classification to get wrong; order-independent sync; doesn't assume `matchLog` is complete | Snapshot baseline + log (pre-2.0.0, repeatedly buggy); replay from scratch (broke on upgrade) |
| Merges never prompt | Union is always unambiguous | Prompt on "diverged" (pre-2.0.0) |
| Deletes are tombstoned; field edits are last-write-wins | Deletion had a real resurrection failure; edits didn't | Replay all edits as events |
| Undelete as a parallel log, latest-ts per id | Unblocks re-creating a title with no unique event ids and no migration | Local-only "strip tombstone" tool |
| Renames as tombstones with `renamedTo` | Receivers keep their own ratings; no new log, collection, or schema bump | A separate rename log |
| Firestore, one doc per fact, via CDN | Free tier, real security rules, no server; idempotent writes | Custom backend; a single JSON blob doc (pre-2.0.0) |

---

## Known limitations & performance thresholds

### Rendering

`renderLibrary()` and `renderLB()` rebuild their lists with `innerHTML`, but both cap how much they render: the Library is paginated and the Leaderboard loads 50 rows at a time (and skips rendering while hidden). Leaderboard rows aren't recycled, so scrolling very deep or using Show all still puts every row in the DOM.

| Items per category | Symptom | Fix |
|---|---|---|
| < 500 | None | — |
| 500–2,000 | Only when the Leaderboard is scrolled deep / Show all | Virtual scrolling ([clusterize.js](https://clusterize.js.org/)) if it matters |
| 2,000–10,000 | localStorage pressure | IndexedDB + virtual scrolling |
| 10,000+ | Both | Backend + virtual scrolling |

Real categories do exceed 500 — NBA Players has ~4,900 items.

### localStorage cap

Browsers allow roughly 5M characters per origin. Items *and* the ever-growing `matchLog` count toward it (an Aug 2026 backup was ~2.8 MB). Hitting the limit is loud (see "Persistence") but still stops saving. Fix: IndexedDB.

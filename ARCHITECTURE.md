# Ranker — Architecture & Developer Guide

A single-file web app for ranking anything using pairwise ELO comparisons. Categories are fully user-defined with custom fields. No build step, no dependencies, no server required.

---

## Quick start

Open `index.html` in any modern browser. That's it.

---

## Current versions

| | Value |
|---|---|
| App version | `2.7.0` |
| Data schema version | `6` |
| localStorage key | `ranker-v1` |

Both constants live at the top of the `<script>` block and are the single source of truth. The Data tab displays them at runtime alongside the schema version of whatever is currently saved to localStorage.

Full release history for both version numbers lives in [CHANGELOG.md](CHANGELOG.md), kept separate from this doc since it only ever grows and isn't needed to understand how the app currently works.

### How to bump versions

When making changes:
1. Update `APP_VERSION` at the top of the script following semver (major = breaking/needs migration, minor = new feature, patch = bug fix)
2. If `state`'s shape changed, increment `DATA_SCHEMA_VERSION` and add a migration case in `load()` and `importData()`
3. Update the "Current versions" table above
4. Add a row to the relevant table(s) in [CHANGELOG.md](CHANGELOG.md)

---

## Adding a new schema version

When the shape of `state` needs to change, follow these steps together — the migration and the version bump always travel as a pair:

1. Increment `DATA_SCHEMA_VERSION` at the top of the script
2. Add a `if (v < N)` block inside `migrateData()` describing what changed and transforming old data to the new shape
3. Add a row to the data schema version table in [CHANGELOG.md](CHANGELOG.md)
4. Update the app version (minor bump if backward compatible, major if not)
5. Add a row to the app version table in [CHANGELOG.md](CHANGELOG.md)

Example block structure:

```js
if (v < 4) {
  // v3 → v4: describe what changed here
  Object.values(data.items || {}).forEach(item => {
    // transform item shape
  });
}
```

`migrateData()` is called in two places — `load()` (for localStorage data) and `importData()` (for uploaded files) — so migrations apply automatically regardless of how old data enters the app.

---

## File structure

Everything lives in one file: `index.html`

```
index.html
├── <style>       CSS custom properties + all component styles (~180 lines)
├── <body>        Seven views: Library, New Category, Schema Editor, Rank, Leaderboard, History, Data
└── <script>      All app logic (~2490 lines of vanilla JS)
```

---

## Data model

All state is held in a single `state` object in memory and mirrored to `localStorage`.

```js
state = {
  cats: ['Movies', 'Songs', ...],   // ordered list of category names

  schema: {
    "Movies": {
      primary: 'Title',             // label for the main field (e.g. "Name", "Title", "Place")
      fields: [
        // identity: true (2.1.0) — this field's value is folded into itemKey()'s hash,
        // so items with the same title but different Year are distinct, not a collision.
        // Setting identity also forces required (see "Item identity fields" below).
        { name: 'Year', required: true, filterable: true, identity: true },
        { name: 'Director', required: false, filterable: true }
      ]
    },
    "Songs": {
      primary: 'Title',
      fields: [
        { name: 'Artist', required: true, filterable: true },
        { name: 'Album', required: false, filterable: false },
        ...
      ]
    }
  },

  items: {
    "<id>": {
      id:        string,   // itemKey(cat, title, identitySuffix) — deterministic hash, e.g.
                            // "i1en785j". Two devices adding "the same" item independently
                            // land on this same id, so merging never needs an identity-
                            // matching/remap step. Renaming an item's title (or editing an
                            // identity field's value — see "Item identity fields" below)
                            // changes its id (see itemKey()).
      cat:       string,   // must match a value in state.cats
      title:     string,   // value of the primary field
      fields: {            // values for all extra schema fields
        "Artist": "Radiohead",
        "Album": "OK Computer",
        ...
      },
      elo:       number,   // starts at 1000
      wins:      number,   // times chosen in a comparison
      losses:    number,   // times not chosen in a comparison
      hidden:    boolean,  // if true, excluded from ranking selection and the leaderboard; still visible/editable in Library
      updatedAt: number    // Date.now() of last title/field edit; used by mergeImport() for last-write-wins field merging
    }
  },

  history: [            // array of recent rankings (max 50 entries), with undo support
    {
      type: 'standard'|'podium'|'tier',  // ranking mode
      category: string,
      timestamp: number,  // Date.now()
      winner: { id, title, eloChange },  // for standard mode only
      loser: { id, title, eloChange },   // for standard mode only
      podium: [...],      // for podium mode: [{id, title, place}, ...]
      tiers: [...],       // for tier mode: [S_items[], A_items[], B_items[], C_items[], D_items[]]
      updates: [...],     // for podium/tier: [{wid, lid, wChange, lChange}, ...] for undo reversal
      matchIds: [...]     // ids of the matchLog entries this ranking created — removed from
                           // matchLog on undo, so an undone comparison is never later merged in
    }
  ],

  // Append-only log of every pairwise result this device knows about, going forward
  // from the v6 migration — never compacted or reset again. NOT guaranteed to be a
  // device's complete lifetime history: pre-v6 data compacted matchLog into a baseline
  // snapshot after every sync and cleared it, so an upgraded device's matchLog may only
  // be the tail since its last pre-rewrite sync, with everything before that already
  // baked into item.elo/wins/losses instead. mergeImport() accounts for this — see
  // "Merging rankings between devices" below and applyNewMatches().
  matchLog: [
    { id: string, cat: string, wid: string, lid: string, ts: number, seq: number }
  ],

  // Append-only, permanent log of deletion tombstones — the same "never compact, union
  // by id" treatment as matchLog, but for item removals. Resolved against itemUndeletes
  // below (whichever has the later ts per itemId wins) rather than being an unconditional
  // permanent block — see "Item deletions" below. title/cat are informational only
  // (never read by merge logic), snapshotted at delete time so the Deleted Items UI can
  // show something human-readable instead of an opaque id hash.
  itemDeletes: [
    { itemId: string, ts: number, deviceId: string, title: string, cat: string }
  ],

  // Append-only log of "undo a delete" facts (2.2.0) — same shape and treatment as
  // itemDeletes. An item is currently tombstoned iff its latest itemDeletes entry is
  // newer than its latest itemUndeletes entry for the same itemId (ties favor deleted).
  // See currentlyTombstonedIds() and "Item deletions" below for why this exists:
  // deterministic ids + an unconditional tombstone meant delete-then-recreate of "the
  // same" item (same title + identity field values) was permanently blocked from ever
  // syncing again — a real incident, not a hypothetical.
  itemUndeletes: [
    { itemId: string, ts: number, deviceId: string, title: string, cat: string }
  ],

  // Category-level tombstones (2.5.0) — same shape and "latest ts per key wins"
  // resolution as itemDeletes/itemUndeletes above, but keyed by category name instead
  // of itemId. confirmDeleteCat() already tombstoned a deleted category's *items*
  // individually via deleteItemsInCat(), so those synced correctly — but the category
  // name/schema itself had no tombstone anywhere, and unionItemsAndSchema()'s cats/
  // schema merge is purely additive, so a deleted category just silently stuck around
  // forever on any device that already had it. See "Category deletions" below.
  // Unlike items, undelete here isn't a deliberate user action with a button — there's
  // no data to restore either way (a category's items/schema are already gone once
  // deleted), so saveNewCat() just unconditionally pushes an undelete fact for
  // whatever name it creates, and a (re)created category name always just works.
  catDeletes: [
    { cat: string, ts: number, deviceId: string }
  ],
  catUndeletes: [
    { cat: string, ts: number, deviceId: string }
  ],

  // Local-only cursor (ms since epoch) marking how far this device has pulled from
  // Firestore, so pullFromFirestore() only fetches what's new. Not part of the merge
  // model itself — a fresh device with lastSyncedServerTs === null just fetches
  // everything on its first pull, same as any other pull. Stripped from file exports
  // (see buildExportPayload()) since it means nothing to whoever imports the file.
  lastSyncedServerTs: number | null
}
```

### Export format

Exported JSON wraps `state` with a `_meta` block:

```json
{
  "_meta": {
    "appVersion": "2.0.0",
    "dataSchemaVersion": 6,
    "exportedAt": "2026-07-05T12:00:00.000Z"
  },
  "cats": [...],
  "schema": {...},
  "items": {...},
  "matchLog": [...],
  "itemDeletes": [...]
}
```

`settings.deviceId`, `settings.userName`, and `lastSyncedServerTs` are stripped before export (see `buildExportPayload()`) — they're personal, per-browser bookkeeping, same treatment as `hidden`.

### CSV preload format

One file per category. `#directive` rows define the schema; the first non-`#` row is the column header; remaining rows are data.

```
#category,NBA Players
#primary,Name
#field,Team,optional
#field,Position,required
#field,Draft Year,optional
Name,Team,Position,Draft Year
LeBron James,Lakers,SF,2003
Stephen Curry,Warriors,PG,2009
```

Rules:
- `#category` and `#primary` are required
- Each `#field` row takes a name and `required` or `optional`
- The header row must include the primary label and all field names
- Quoted fields with commas inside are supported
- On import into an existing category, a prompt offers three options:
  - **Bulk add** — matches on title (case-insensitive); updates field values on matches, preserves ELO and win/loss; adds new titles at ELO 1000. Use this to apply corrections or add new items without losing rankings.
  - **Replace** — wipes all existing items and rankings for the category, then imports fresh
  - **Cancel** — aborts with no changes

The "Export category as CSV" button in the Data tab produces a file in this exact format — making it easy to share a clean library with another user who can import it and start ranking from scratch with no inherited ELO scores.

### Persistence

`localStorage` key: `ranker-v1`

`save()` serializes the full `state` object on every write. `load()` deserializes it on page load, applying any needed migrations. The app also checks for the legacy `media-ranker-v1` key and migrates it automatically on first load.

### Merging rankings between devices

JSON import (and Firestore pull) always goes through `mergeImport()`, which is now an **unconditional set union by id** — there is no "which side is ahead" question, no baseline, no ancestry chain, and no confirm dialog. Three real bugs in a row (1.17.1, 1.18.0, 1.18.1) all traced back to the same root cause: classifying how two client-side snapshots relate before picking a replay strategy is inherently fragile. As of 2.0.0 (schema v6) that classification step is gone entirely, not patched again.

*(The original design-scratch notes from before this rewrite — including the discarded baseline/ancestry approach — are kept locally, untracked, in `log/archive/` for historical context; not needed to understand the current design below.)*

`mergeImport(incoming)` does, in order:
1. **Union tombstones** — `state.itemDeletes` and `incoming.itemDeletes` combined, deduped by `itemId`. Any item whose id is now tombstoned is deleted locally if still present, *before* items are unioned in, so an incoming copy that doesn't yet know about a delete can't resurrect it. See "Item deletions" below.
2. **Union items** — new items (not in `tombstoneIds`) are added unconditionally (deterministic ids make this collision-free), defaulting `elo`/`wins`/`losses` to `1000`/`0`/`0` if `incoming` doesn't carry them; items both sides already have use last-write-wins on `fields` via `updatedAt` (title never conflicts — a title edit changes the item's id, see `itemKey()`). Tracks which item ids were just created as `freshlySeeded` — see step 3.
3. **Apply only genuinely new, non-double-counted matches** — `applyNewMatches()` filters `incoming.matchLog` down to entries whose `id` isn't already in local `state.matchLog`, then further excludes any match touching a `freshlySeeded` item (see the "double-counting" note below), sorts what's left by `(ts, seq)`, and applies each directly onto whatever live item ratings are already there (same `eloUpdate()` a real vote uses). Only the matches actually applied are added to `state.matchLog`.

This is safe and idempotent by construction: importing/pulling the same file twice is a no-op the second time (no match id is "new" anymore), and it doesn't matter what order two devices push/pull in, because nothing is ever overwritten — only added to. `hidden` continues to never travel in either direction (personal per-browser preference, stripped on export and forced to `false` on any newly-adopted item).

**Second real bug found in review, fixed same-day as 2.0.1 (shipped as 2.0.2): freshly-created items double-counted their own matches.** A file export's items and its `matchLog` are two views of the *same* live history on the source device — an item's `elo`/`wins`/`losses` already reflect every match touching it that's also present in that same export's `matchLog`. When importing into a device that doesn't have that item yet, step 2 adopts the item's rating wholesale (already correct), but step 3 would then also *replay* those same matches on top of it via `applyNewMatches()` — double-counting them. This is most visible exactly when it matters most: recovering a wiped device from another device's full export. Fixed by excluding any match where either side is in this merge's `freshlySeeded` set. **Known, narrower tradeoff this introduces:** if a match pairs a freshly-seeded item against an item that *already* existed locally, that match is skipped entirely this merge (neither item's rating is touched by it) rather than partially applied — ELO updates are coupled (both sides move together), so there's no clean way to apply "half" of one. Skipped matches are deliberately *not* added to local `matchLog`, so a later merge (once the item is no longer fresh) can still pick it up and apply it correctly. This is a temporary, self-correcting undercount on the *pre-existing* item's win/loss count, not data loss or a permanent gap — accepted as a much better failure mode than double-counting.

**Third real bug, fixed same-day, shipped as 2.0.3: the 2.0.2 fix above broke Firestore pulls entirely for new items.** `freshlySeeded` was being set unconditionally for any brand-new item, on the assumption (true for file exports) that its incoming rating already reflects every match touching it. That assumption doesn't hold for Firestore: `rankers/shared/items/{itemId}` docs never carry `elo`/`wins`/`losses` at all (see "Cloud sync" below), so a new item pulled from Firestore always starts at the 1000/0/0 default with *nothing* baked in — yet step 3 was still treating it as `freshlySeeded` and excluding every match that touched it. Those matches were then never applied *and* never added to local `matchLog` (only applied matches are), so they were silently dropped rather than deferred — the item stayed at 1000/0/0 forever, with a "synced" toast and no visible error. Reported live: User A added an item and recorded 10 comparisons, pushed; User B pulled, got the item and the sync toast, but no rating changes; reversed roles reproduced identically. Fixed by only adding an item to `freshlySeeded` when its incoming payload actually carries a rating (`inc.elo !== undefined`) — true for file-export/import items, false for Firestore-sourced items, which now always have their matches applied normally on first pull.

**Critical: this must NOT be a from-scratch replay, and briefly was — a real data-loss incident, fixed same-day.** The first cut of this rewrite had step 3 reset every item to `{elo:1000, wins:0, losses:0}` and replay the *entire* merged `matchLog` forward (`replayAllMatches()`, since removed). That's wrong because `state.matchLog` is **not guaranteed to be a device's complete lifetime history** — pre-2.0.0 data compacted `matchLog` into a baseline snapshot after every sync and cleared it, so any device that had synced before upgrading carried forward only the *tail* since its last pre-rewrite sync, with everything before that already baked into `item.elo`/`wins`/`losses` instead (untouched by the v6 migration, which correctly left item ratings alone). A from-scratch replay reset those already-correct items to 1000 and rebuilt them from only the short tail, silently discarding everything the old baseline had compacted — live, on the very first Pull/Upload/Import after upgrading. `applyNewMatches()` never resets anything; it only ever adds deltas on top of whatever's already there, so it works correctly regardless of whether `matchLog` happens to be complete or not.

**Known, accepted tradeoff — match order across two devices isn't globally reconstructed.** `applyNewMatches()` sorts only the *newly incoming* matches by `(ts, seq)` and applies them on top of current live ratings — deterministic and safe (every match still counts exactly once, nothing is ever dropped), but the resulting ELO isn't necessarily "what it would have been had these two people voted in true wall-clock real time on a shared list," since it depends on what each side's ratings already were at merge time. Client clocks can also disagree, and `seq` is only comparable within one device's own log. This is fine for the app's actual goal (no data loss, same *matches counted* regardless of sync order) and is a much simpler, more robust property than the old baseline/ancestry system ever guaranteed in practice.

**Why not full replay-from-scratch, then:** it's the more obviously "correct-looking" design (deterministic, no dependence on what's already there) and was the original implementation — but as above, it silently assumes `matchLog` is a complete history, which isn't true for anyone upgrading from pre-2.0.0. Applying only new deltas on top of live ratings has no such assumption baked in.

**Why not the original baseline/ancestry design either:** that design was built to bound replay cost to "comparisons since the last sync," not lifetime volume — reasonable-looking on paper, but the actual cost was a steady stream of client-side reconciliation bugs (1.17.1, 1.18.0, 1.18.1), because "which snapshot is ahead" is a surprisingly easy question to get subtly wrong. The current design has no classification step to get wrong, at the cost of the ordering caveat noted above.

### Item deletions

Deletion is tracked the same way matches are — a permanent, replayable fact, not a silent local-only mutation. Previously (pre-2.0.0) deletions weren't tracked at all: deleting an item locally and later merging with a device that still had it just brought it back, with no way to detect or prevent that.

- `deleteItem(id)` and `deleteItemsInCat(cat)` both append a tombstone `{ itemId, ts, deviceId, title, cat }` to `state.itemDeletes` in addition to removing the item from `state.items` — the same pattern `recordMatch()` already uses for `state.matchLog`. `title`/`cat` are informational only, snapshotted for the Deleted Items UI.
- `mergeImport()` unions tombstones from both sides via `latestPerItemId()`, then removes any currently-tombstoned item locally *before* unioning items in — see "Merging rankings between devices" above.
- Deliberately **not** extended to field edits (title/fields changes) — those stay last-write-wins via `updatedAt`. Low collision risk, low stakes if it does collide, and full edit-history replay isn't something this app needs. Deletion got the tombstone treatment because it was the one case with an actual, documented failure mode (item resurrection on merge).

**Undelete (2.2.0).** A tombstone is no longer an unconditional, permanent block — it's resolved against a parallel `state.itemUndeletes` log, same shape and treatment as `itemDeletes`. This exists because of a real incident: deterministic item ids (`(cat, title, identity field values)` — see "Item identity fields" below) mean deleting an item and later recreating one with the exact same title + identity value(s) computes to the *same id*, which an unconditional tombstone would then permanently block from ever syncing again, on any device that ever saw the delete — happened live with two "Superman" entries, requiring manual Firestore + console intervention to fix, not repeatable on a device that becomes unreachable.

- `latestPerItemId(list)` reduces either log to one entry per `itemId` — whichever has the max `ts`. This is safe across unlimited delete→undelete→delete cycles without needing per-event unique ids or a migration: each reduction always keeps the newest fact for a given item, and only the single latest fact of each type ever needs to be retained.
- `currentlyTombstonedIds(deletes, undeletes)` — an item is tombstoned iff its latest delete is newer than its latest undelete (or no undelete exists). **Ties favor deleted**, the same safe default used elsewhere (e.g. simultaneous delete/item-doc arrival). `undeleteItem(itemId)` guarantees its own `ts` is always strictly after the delete it's reversing (`Math.max(Date.now(), tombstone.ts + 1)`) — otherwise a user undeleting immediately after their own delete could land in the same millisecond and get silently overridden by the tie-favors-deleted rule. Caught by testing during implementation, not by inspection.
- `undeleteItem(itemId)` (Data tab → "Deleted items" → Undelete) pushes to `itemUndeletes`. **Does not restore the item's old data or rating** — `state.items[itemId]` is long gone if this device did the original delete. It only clears the sync block going forward: either this device can now successfully recreate an item with that identity and have it sync, or if another device still has (or recreates) a copy, this device can now pull it in. Stated explicitly in the UI copy so it isn't mistaken for a real restore.
- Cloud sync mirrors `itemDeletes`' plumbing exactly: `uploadToFirestore()`/`pullFromFirestore()` gain symmetric `itemUndeletes` handling with their own `lastUploadedUndeletesAt` cursor; Firestore docs are keyed by `itemId` (not a unique event id) — same as `itemDeletes` already was, where a second delete of the same item already overwrote the same doc, updating its `ts`, consistent with the max-ts-per-itemId model.
- Purely additive: no `DATA_SCHEMA_VERSION` bump. `itemUndeletes`/`lastUploadedUndeletesAt` are backfilled via the same unconditional "ensure new optional fields exist" tail in `migrateData()` that `itemDeletes` itself uses — no migration block needed.
- **Bug fix, real report, same-day as 2.2.0: `uploadToFirestore()` crashed on any tombstone created before `title`/`cat` existed on `itemDeletes`.** Real-world tombstones predating this feature have no `title`/`cat` at all, so `t.title`/`t.cat` in the write payload were genuinely `undefined` — and Firestore's SDK rejects `undefined` field values outright (`WriteBatch.set() called with invalid data. Unsupported field value: undefined`), a client-side throw before the write is even sent, caught by `uploadToFirestore()`'s try/catch and surfaced as a generic "Cloud sync error" toast. Hit live: an undelete of a pre-2.2.0 tombstone, then Upload. Fixed by falling back to `null` (`t.title ?? null`, `t.cat ?? null`) in both the `itemDeletes` and `itemUndeletes` write payloads — Firestore accepts `null` fine, just not `undefined`. Caught by a test harness bug of my own along the way: mocking `cloudDb`/`cloudUser` via `window.cloudDb = ...` silently no-ops, since these are top-level `let` bindings in a non-module script, not `window` properties — assigning the bare identifier directly is required for a test to actually exercise `uploadToFirestore()`'s body instead of returning at its `if (!cloudAvailable || !cloudUser) return;` guard.
- **Known limitation: a surviving item's win/loss count can differ slightly by device when a match against a since-deleted item is still propagating.** Deleting an item never retroactively undoes the ELO it already applied to its opponent's *live* rating (same as before 2.0.0 — deletion has no undo). On the device where the vote happened, that effect is permanently baked into the opponent's rating regardless of the later delete. On a *different* device merging in both the tombstone and that match as new facts at once, `applyNewMatches()` skips the match (the tombstoned item is already gone locally by the time matches are applied — see `mergeImport()`), so the opponent never incurs it there. Not data loss (the discrepancy is a few ELO points/one win-loss count on the *surviving* item, not a missing item or a wiped history), and rare in practice (only visible when a delete and a match against that item reach a third device via different merge timing) — documented here rather than engineered around, given the complexity a full fix would need (retaining per-match opponent-elo-at-time-of-match, which the app doesn't otherwise track).
- Firestore's `itemDeletes` and `itemUndeletes` subcollections need the same two-UID security rule as `items`/`matches` — see "Cloud sync" below.
- **`renderDeletedItems()` caps its render to the most recent `DELETED_ITEMS_PAGE_SIZE` (50) by default (2.5.3), with a "Show all"/"Show fewer" toggle (`deletedItemsShowAll`).** `state.itemDeletes` itself is deliberately never capped or compacted — a tombstone must persist forever for "deletion always wins" to hold — but rendering every single one as its own row with an Undelete button doesn't scale to bulk operations. Real report: a one-time recovery cleanup for the identity-flag duplication bug (2.5.2) produced roughly 1,500 tombstones in a single sitting, making the Deleted Items section unusable. Unlike History's cap (which limits what's actually *stored*, since old rankings genuinely stop mattering once they age out), the underlying deletion data here has to stay complete for correctness — only the render is capped.

### Category deletions (2.5.0)

`confirmDeleteCat()` always removed a category from local `state.cats`/`state.schema` and tombstoned each of its items via `deleteItemsInCat()` — so the items really did vanish everywhere on sync, using the same machinery as any other item delete. But the category itself (its name and schema) had **no tombstone at all**. `unionItemsAndSchema()`'s cats/schema merge is a plain, permanent union — it only ever adds a category name/schema entry that's missing locally, never removes one that's simply absent from an incoming payload. So a device that already knew about a category before it was deleted elsewhere would keep it forever (now empty of items, but still selectable, still with its full field schema) — pulling never told it the category itself was gone. Category *creation*, by contrast, already worked correctly: it's purely additive, the same union logic that already handles new items.

- `confirmDeleteCat()` now also pushes `{ cat, ts, deviceId }` to `state.catDeletes` — same shape and treatment as `itemDeletes`, keyed by category name instead of item id.
- `mergeImport()` unions `catDeletes`/`catUndeletes` from both sides via `latestPerCat()` (a `latestByKey()` wrapper shared with `latestPerItemId()`), computes `currentlyTombstonedCats()`, and — before unioning anything in — removes any newly-tombstoned category's name, schema, *and any items still under it* from local state. That last part matters even though items are already individually tombstoned: a device that added a brand-new item to a category *concurrently*, before learning the category was deleted elsewhere, has no tombstone for that one item specifically. Without the category-level check too, that single untombstoned item would resurrect the whole "deleted" category on both sides — the same class of bug `itemDeletes` fixed for items in 2.0.0, one level up. `unionItemsAndSchema()` (now taking a third `tombstonedCats` argument) applies the same skip to its own items/cats/schema loops, for incoming payloads that haven't gone through the pre-union purge (i.e. the local side's own tombstoned-category items, which the purge already removed, vs. the incoming side's, which this catches).
- **No dedicated "Undelete category" UI, unlike items — and deliberately so.** Item undelete exists because *not* having it would permanently block re-syncing "the same" item ever again (the Superman incident), and a user has to consciously decide to accept that. A category has no comparable data to lose or consciously restore — deleting one already permanently wipes its schema and items via the existing item-tombstone path. So instead of a button, `saveNewCat()` unconditionally pushes a `catUndeletes` fact (with `Math.max(Date.now(), priorDeleteTs + 1)`, same tie-safety as `undeleteItem()`) for whatever name it creates, every time. Creating a category named "Foo" — whether "Foo" has never existed, or existed and was deleted years ago — just always works and always syncs, with no user action required to clear a block they'd have no reason to know exists.
- Cloud sync mirrors `itemDeletes`/`itemUndeletes` exactly: new `rankers/shared/catDeletes`/`rankers/shared/catUndeletes` subcollections, `uploadToFirestore()`/`pullFromFirestore()` gain symmetric handling with their own `lastUploadedCatDeletesAt`/`lastUploadedCatUndeletesAt` cursors. Firestore doc ids can't safely be the raw category name (arbitrary user text can contain characters Firestore doc ids reject, e.g. `/`), so docs are keyed by `catKey(cat)` — the same hash `itemKey()` uses, `'c'` prefix instead of `'i'` — with the real name stored in the `cat` field.
- Purely additive, same as `itemUndeletes` was in 2.2.0: no `DATA_SCHEMA_VERSION` bump, backfilled via `migrateData()`'s unconditional "ensure new optional fields exist" tail.
- **Requires updating the Firestore security rules** to add the new `catDeletes`/`catUndeletes` subcollections to the existing two-UID allowlist — see "Cloud sync" below.

### Item identity fields (2.1.0)

Lets two items in the same category share a title, distinguished by another field's value — e.g. two "Dune" movies distinguished by Year. Before this, `itemKey(cat, title)` hashed only category + title, so same-titled items always collided: `addItem()` blocked adding the second one outright, and — worse — `bulkAddCSVImport()` matched existing items by title alone and *silently overwrote* the existing item's fields on a "duplicate," destroying its distinguishing data with no warning beyond a generic "updated" count. Real report, confirmed live: importing a CSV row for "Dune" (2021) overwrote an existing "Dune" (1984) entry's Year/Director fields.

- A schema field can be flagged `identity: true` in the Schema Editor (alongside `required`/`filterable`) — same per-field-toggle-button pattern as `filterable`. Marking a field identity also forces `required: true` on it: a blank identity value gives weak disambiguation (two items with the same title and both blank would still collide).
- `identitySuffixForFields(idFields, fields)` builds a deterministic suffix string from whichever fields are flagged identity, sorted by field name (so multiple identity fields are supported, order-independent) and value-normalized the same way title already is (`trim().toLowerCase()`). `identitySuffixFor(cat, fields)` is the version that reads a category's *saved* schema; `saveSchema()`'s pending-rekey check uses `identitySuffixForFields()` directly against the not-yet-saved `editingFields`, since the new schema isn't in `state.schema` yet at that point.
- `itemKey(cat, title, identitySuffix = '')` folds this into its hash. **Purely additive and backward compatible**: a category with no identity fields produces a suffix of `''`, making the hash byte-identical to before this feature existed — no `DATA_SCHEMA_VERSION` bump, no migration needed for anyone not using it.
- Every call site that computes an item id (`addItem()`, `saveItem()`, `bulkAddCSVImport()`, `applyCSVImport()`) goes through `identitySuffixFor()`/`identitySuffixForFields()` — there is deliberately no second, parallel notion of "same item" anywhere (the old `bulkAddCSVImport()` title-only lookup was exactly that kind of drift, and it's what caused the overwrite bug above).
- **Editing an identity field's value is a rename**, same as editing the title already is — `saveItem()`'s rekey condition is now "does the computed id change" (covers both title and identity-field edits) rather than "did the title string change." Same accepted tradeoff as an ordinary rename: local-only, `matchLog`/`history` referencing the old id are not remapped here (see "Known limitations" below) — that gap predates this feature and is out of scope for it.
- **Toggling which fields are identity for an existing category is a bulk operation**, handled inside `saveSchema()`: it diffs old vs. new identity-flagged field names, and if changed, computes every existing item's new id, then either applies the rekey or blocks the save entirely.
  - `remapItemIds(idMap)` does the actual rekey — same remap shape as the v4 migration that originally introduced `itemKey()` (see `migrateData()`'s `v < 4` block): rewrites `state.items`, then walks `state.matchLog` (`wid`/`lid`), `state.itemDeletes` (`itemId`), and `state.history` (winner/loser/podium/updates ids) so nothing is left pointing at a stale id. This is the one place identity-field rekeying *does* get the full remap treatment (unlike the single-item rename case above) — a schema toggle can affect a whole category's worth of items/matches/history at once, a much larger blast radius than one manual rename.
  - **Collision detection**: if two *different* existing items would resolve to the same new id (only possible when *removing* an identity flag that was previously disambiguating them — e.g. un-flagging Year when both a 1984 and 2021 "Dune" already exist), the save is **blocked** with a toast naming both titles, and the schema is left unchanged. This must compare original item ids, not titles — colliding items necessarily already share a title (that's what made them ambiguous without the identity field), so a title comparison alone can never detect the collision. Caught by testing during implementation: an earlier version of this check compared titles and silently merged the two items instead of blocking, exactly the destructive bug this feature exists to prevent.
  - Rekeyed items get a fresh `updatedAt` so the next Upload re-pushes them under their new ids. The old ids' Firestore docs are left orphaned (not deleted/tombstoned) — this is a rename, not a removal, same accepted tradeoff as an ordinary title rename.
- **Identity flags now propagate through merge/import/pull for existing categories (2.3.0).** Originally *no* schema edit synced for a category the receiving device already had any schema for — including identity flags, and including built-in categories, since e.g. Movies always has a default schema locally from `CAT_DEFAULTS` the moment the app loads, so even a freshly-cleared device already "has a schema" and the old `if (!state.schema[c])` union check skipped adopting anything from the incoming side. Real report: a fresh import of a full baseline into a wiped device didn't carry over the source device's identity flag, because "fresh" only meant no *items*, not no *schema*. Fixed via `unionItemsAndSchema()` → `adoptIncomingFields(cat, incomingFields)`: for a category the device already knows, it adopts any field the incoming side has flagged `identity: true` that the local side hasn't — **monotonic, only ever turns identity on, never off** (removing one is the collision-risk direction the interactive Schema Editor check exists to guard; a device merely being unaware of a flag someone else already set is not grounds to strip it from them).
  - Adopting a newly-synced identity flag on an existing category needs the exact same rekey (and the exact same collision safety) `saveSchema()` already does when a user toggles it interactively — so that logic was extracted into a shared `rekeyItemsForIdentityFields(cat, pendingIdFields)`, called by both, rather than duplicated (duplicated collision logic is exactly what already drifted and caused a real bug earlier in this feature's own development — see above). Schema and item ids are never allowed to go out of sync: the field-list change is only committed if the rekey actually succeeds; on the (only realistically possible with pre-existing corrupted data) collision case, the identity adoption for that category is skipped silently for this merge (logged via `console.warn`, not a user-facing error, since background sync has no one to show a toast to) rather than left half-applied — it can still be resolved later via the interactive Schema Editor path once a user is present to see the collision.
- **Entirely new (non-identity) fields now also propagate (2.5.1) — `required`/`filterable` on an *already-shared* field still don't, deliberately.** Until this fix, adding a brand-new field to an existing category and filling it in on an item was a real, silent gap: the item's *value* for that field already synced fine (last-write-wins on the whole `fields` object — see "Merging rankings between devices"), but with no matching entry in the receiving device's schema, that value was invisible everywhere — Library rows, the edit form, filters all iterate `extraFields(cat)`, i.e. schema-defined fields only. Real report, reproduced and fixed same session: User A added a field and filled it in, pushed; User B pulled and got the item with the new value silently present in its data but nowhere visible in the UI. `adoptIncomingFields()` (renamed from `adoptIncomingIdentityFields()`, since it now does more) fixes this the same "adding is always safe" way new items and new identity fields already were: a field this device has never heard of, by name, is added wholesale — carrying whatever `required`/`filterable`/`identity` it has incoming — no rekey needed, since a brand-new field can't yet affect any existing item's id (`identitySuffixFor()` only reads fields *already* flagged identity). `required`/`filterable` on a field *both* sides already have remain local-only, unchanged from 2.3.0's reasoning: low collision risk, low stakes if they diverge, unlike identity which is correctness-critical for id computation — extending sync to those would mean picking a winner between two devices' independent edits with no natural "adding is safe" framing to fall back on, the same reconciliation fragility the 2.0.0 rewrite moved away from. A brand-new field that's *also* flagged identity still goes through the existing rekey-with-collision-check path — the two are independent per-field, so one field's brand-new-and-safe addition never blocks on another field's identity-and-needs-a-rekey addition, or vice versa.
- **Pulling into a device whose identity flags are behind no longer duplicates the whole category (fixed 2.5.2) — previously required a manual rollout-order workaround.** `unionItemsAndSchema()` used to union incoming *items* before adopting incoming *schema* — but adopting a newly-synced identity flag rekeys every existing local item in that category onto a new id scheme (`adoptIncomingFields()` → `rekeyItemsForIdentityFields()`). Unioning items first, against ids still computed under the device's *old* scheme, meant every incoming item (computed under the sender's *newer* scheme) failed to match any local item and got added as a "new" duplicate right alongside the original — not a rare edge case, every item in the category, unconditionally, any time a pull carried a schema the local device's identity flags were behind on. Real report, reproduced and fixed same session: after finally being able to pull again (see the Firestore rules note below), every item in Library appeared duplicated. Fixed by reordering `unionItemsAndSchema()` to adopt schema/identity first, so local items are already rekeyed onto the same scheme incoming ids use by the time they're compared — they now correctly line up and merge into one, regardless of pull order. This is the same bug the workaround below used to describe from the *opposite* direction (pre-flagging B before pulling to avoid it); that workaround is no longer necessary, though the note is kept for historical context since older exported files can still carry pre-fix behavior if merged with a pre-2.5.2 build.
- **Previously accepted rollout-order tradeoff (largely superseded by the fix above):** flagging identity rekeys *every* item in the category, not just the ones that were colliding — so a device pulling another's post-flag data before flagging identity locally used to see every item look brand-new and get duplicated (now fixed — see above). One narrower case can still produce a genuine duplicate: if device A also *renamed* an item as part of the identity cleanup (e.g. "Dune (1984)" → "Dune"), that rename's own tombstone-based propagation (see "Editing an identity field's value is a rename" above) is unaffected by this fix and still needs the old id's tombstone to reach B before B's stale old-titled copy is retired.
- **Known, real incident: permanent tombstones + deterministic ids can permanently block re-syncing "the same" item.** Deleting an item (via `deleteItem()`) is permanent by design — a tombstone always wins over an item doc at the same id, on any device, forever (see "Item deletions"). Since ids are now deterministic from `(cat, title, identity field values)`, deleting an item and *later re-creating* one with the exact same title and identity-field value(s) — even on a different device, even much later — computes to the identical id, which is now permanently tombstoned. The re-created item can be pushed to Firestore fine, but no device that has ever seen that tombstone (locally or via a prior pull) will ever accept it back in; `unionItemsAndSchema()`'s `if (tombstoneIds.has(inc.id)) return;` skips it silently, with no error. Live incident: two "Superman" entries (2025/1978) were deleted and recreated during identity-field cleanup; one device had already deleted-then-locally-recreated the same title+Year combination earlier and uploaded that tombstone, permanently blocking every subsequent re-upload of "Superman" (2025)/(1978) for that device (and anyone who later pulled from it) until the specific tombstone docs were manually found and removed from Firestore (`rankers/shared/itemDeletes`) and from any device's local `state.itemDeletes` that had already absorbed them — there is no in-app tool for this, it required direct console/Firestore-UI intervention. **Practical guidance:** don't delete-then-recreate an item that shares a title + identity-field value with something you're about to re-add — prefer editing the existing item in place (`saveItem()`) if you need to fix its data instead. This is a real interaction between two individually-correct design decisions (deterministic ids, permanent tombstones), not a bug in either one alone — worth being deliberate about rather than surprised by.

### Cloud sync (Firestore)

An optional second transport alongside the file export/import flow above — same `mergeImport()` union-by-id pipeline either way, just a different way to move facts between two devices. The Data tab's "Cloud sync" card adds Upload/Pull buttons next to the existing file Export/Import controls; neither replaces the other.

**Firestore is a real append-only log, not a blob (as of 2.0.0).** Previously the entire `state` was serialized to one JSON string stored in a single document — simple, but it meant the client-side merge logic had to reconcile two full snapshots on every sync, which is exactly the fragility that produced three real bugs in a row (1.17.1, 1.18.0, 1.18.1). As of 2.0.0, Firestore itself holds one document per fact:

- `rankers/shared` (root doc) — small, low-churn blob: `{ cats, schema, updatedAt, updatedBy }`
- `rankers/shared/items/{itemId}` — one doc per item: `{ cat, title, fields, updatedAt, syncedAt }`. No elo/wins/losses stored here — ratings live only in each device's local `state.items`, kept current by applying new matches directly (see `applyNewMatches()`), never synced as a value in their own right. Because of this, `unionItemsAndSchema()` explicitly defaults a brand-new item's `elo`/`wins`/`losses` to `1000`/`0`/`0` rather than trusting whatever the incoming payload carries — a real bug, fixed same-day as the 2.0.1 replay fix, briefly left these `undefined` (turning into `NaN` on first match) for any item pulled fresh from Firestore. This same "no ratings on a Firestore item doc" fact caused a second bug in 2.0.2's `freshlySeeded` double-counting fix, corrected in 2.0.3 — see "Merging rankings between devices" above.
- `rankers/shared/matches/{matchId}` — one doc per pairwise comparison, ever: `{ cat, wid, lid, ts, seq, syncedAt }`
- `rankers/shared/itemDeletes/{itemId}` — one tombstone doc per deleted item, keyed by `itemId` (a later delete of the same item overwrites this doc, updating `ts`): `{ itemId, ts, deviceId, title, cat, syncedAt }`
- `rankers/shared/itemUndeletes/{itemId}` — one "undo a delete" doc per item (2.2.0), same keying/shape as `itemDeletes`: `{ itemId, ts, deviceId, title, cat, syncedAt }`. See "Item deletions" for how the two logs resolve against each other.
- `rankers/shared/catDeletes/{catKey(cat)}` — one tombstone doc per deleted category (2.5.0), keyed by `catKey(cat)` (a hash, not the raw name — see "Category deletions"): `{ cat, ts, deviceId, syncedAt }`
- `rankers/shared/catUndeletes/{catKey(cat)}` — same keying/shape as `catDeletes` (2.5.0): `{ cat, ts, deviceId, syncedAt }`. See "Category deletions" for how the two logs resolve against each other.

Every subcollection doc's ID is the fact's own id (`itemId`/`matchId`), so writing the same fact twice is an idempotent no-op overwrite, not a conflict — this is what makes push and pull order-independent (see below). `syncedAt` is a Firestore `serverTimestamp()` used only as a pull cursor (see `pullFromFirestore()`); it's separate from `updatedAt`/`ts`, which are client timestamps used for actual data (last-write-wins on item fields, match ordering).

**Push and pull no longer need to happen in any particular order.** The old blob design required pulling before pushing to avoid clobbering another device's upload (fixed in 1.17.1 by merging-before-push) — but that was a workaround for the blob being a single overwritable unit. With one doc per fact, `uploadToFirestore()` just writes whatever's new; there's nothing to clobber.

**Why Firestore, not a custom backend:** the merge logic already runs entirely client-side (`mergeImport()`), so all a backend needs to do is store and serve documents to whoever's authorized. Firestore's free tier does that with no server code to write or host, and its security rules give real per-user access control — a meaningfully better fit than, say, a GitHub Gist with an access token embedded in the page.

**Setup** (see `log/firestore-sync-plan.md` and `log/firestore-append-only-history-plan.md` for the full walkthroughs, not committed — they're gitignored):
1. Create a Firebase project, enable Firestore, enable the Google sign-in provider
2. Register a Web app to get a `firebaseConfig` object
3. Both users sign in once so Firebase records their UIDs
4. Write a security rule restricting `rankers/shared` and its `items`/`matches`/`itemDeletes` subcollections to those two UIDs (see the rules snippet further down)

**Must be served over http(s) — `file://` does not work.** Google sign-in's `signInWithPopup()` requires a real origin; opening `index.html` directly from disk fails with `location.protocol must be http`. This is a hard OAuth requirement, not fixable in app code — it means cloud sync effectively requires the app to be hosted (see "Host it online"), not just opened locally. A quick local static server (`npx serve .`, `python -m http.server`) works for testing against `http://localhost`, which Firebase authorizes by default.

**New domains must be added to Firebase's Authorized domains list.** `localhost` and the project's own `*.firebaseapp.com`/`*.web.app` domains are authorized automatically, but a domain like GitHub Pages' `<username>.github.io` is not — sign-in fails with *"The current domain is not authorized for OAuth operations"* until it's added manually under Firebase Console → Authentication → Settings → Authorized domains. One-time step per hosting domain, not something a code change or redeploy affects.

**Loaded via CDN, not npm** — three `<script src="https://www.gstatic.com/firebasejs/...">` tags for the Firebase compat SDK, placed just before the app's own `<script>` block. The compat build exposes a global `firebase` object (`firebase.initializeApp()`, `firebase.auth()`, `firebase.firestore()`), avoiding any need for `type="module"`/a bundler/`npm install` — consistent with the rest of the app having zero build step. This is the app's first external dependency; everything else is still self-contained.

**The `firebaseConfig` object (apiKey, projectId, etc.) is intentionally committed in plain text in `index.html`.** It is not a secret — Firebase's web config is designed to be public; the actual gate is the Firestore security rule on the document, which checks the signed-in user's UID, not knowledge of this object. (A real secret — e.g. a Firebase Admin SDK service-account key — would be a different story and must never be committed; there's none in this app, which only uses the client SDK.)

**Defensive init:** Firebase initialization runs as top-level code in the same `<script>` block as the rest of the app, so it's wrapped in `try/catch` — an uncaught error there (CDN blocked, ad-blocker, offline, bad config) would otherwise halt every subsequent statement in the file, breaking ranking/library/everything over an optional feature. `cloudAvailable` tracks whether init succeeded; `renderCloudAuthUI()` shows a plain "unavailable" message and leaves Upload/Pull disabled when it's `false`, rather than throwing.

**Upload only pushes what this device hasn't already pushed**, tracked via local per-device cursors in `state.settings`: `lastUploadedItemsAt` (compared against each item's `updatedAt`), `lastUploadedSeq` (compared against this device's own match `seq`, filtered by the `settings.deviceId` prefix on match ids — matches pulled in from elsewhere don't need pushing back), `lastUploadedDeletesAt`/`lastUploadedUndeletesAt` (item tombstones, compared against each entry's `ts`), and `lastUploadedCatDeletesAt`/`lastUploadedCatUndeletesAt` (2.5.0 — category tombstones, same `ts` comparison). All six advance only after every write below succeeds. This bounds upload cost to "what's new," not the whole history's write count — Firestore bills per document write, so re-writing everything every time would both cost more and be pointless now that writes are idempotent anyway.

**Upload is chunked into batches of at most 500 writes (2.0.4).** Firestore hard-caps a single `batch.commit()` at 500 operations — it isn't a quota, it's a request-validation limit, and exceeding it fails the *entire* commit, pushing nothing. The original implementation put every pending item/match/tombstone write into one unconditional batch, which worked fine for routine day-to-day syncing but was a real risk for any single Upload with a large backlog: a long stretch offline, a big CSV import ranked heavily before the first sync, or — the case that surfaced this — a from-scratch device recovery where one device uploads its *entire* lifetime history in one shot. `uploadToFirestore()` now collects every pending write as a `[ref, data]` pair first, then commits them in slices of 500 via sequential `batch.commit()` calls; the small root-doc `cats`/`schema` merge-write always happens last, as its own single-write commit, after every chunk succeeds. Local upload cursors are still only advanced once everything commits — if a later chunk fails (e.g. a dropped connection mid-upload), no cursor moves, and the next Upload attempt safely re-sends everything, including the chunks that already succeeded (harmless idempotent overwrites, since every doc is keyed by its own fact's id).

**Pull only fetches what's new since `state.lastSyncedServerTs`**, a local cursor (`null` on a fresh device, so the first pull fetches everything). Each subcollection doc carries a `syncedAt: serverTimestamp()` field used only for this — `pullFromFirestore()` queries `where('syncedAt', '>', cursor)` on `items`/`matches`/`itemDeletes`/`itemUndeletes`/`catDeletes`/`catUndeletes`, unions the results in via `mergeImport()`, then advances the cursor to the newest `syncedAt` seen.

**Key functions:**
- `cloudSignIn()` / `cloudSignOut()` — Google auth via `signInWithPopup(GoogleAuthProvider)`
- `renderCloudAuthUI()` — reflects auth state into the Data tab card; enables/disables Upload/Pull
- `uploadToFirestore()` — collects new/changed items, this device's new matches, and new item/category tombstones as per-doc writes (keyed by their own id — `catKey(cat)` for category tombstones, see "Category deletions" — so re-sending is a safe no-op), commits them in chunks of at most 500 (Firestore's per-batch limit — see "Cloud sync" above), then a merge-write to the small root doc; advances the local upload cursors only once everything succeeds
- `pullFromFirestore()` — queries `items`/`matches`/`itemDeletes`/`itemUndeletes`/`catDeletes`/`catUndeletes` for anything newer than `state.lastSyncedServerTs`, builds an `incoming` object matching `mergeImport()`'s expected shape, merges it in, advances the cursor
- `cloudErrorMessage(e)` — maps Firestore error codes (`permission-denied`, `unavailable`) to a plain-language toast

**Push and pull can happen in any order, any time, from either device — no pre-pull-before-push workaround needed (unlike the pre-2.0.0 blob design).** Because every doc is keyed by its own fact's id, two devices independently pushing "the same" match or item just results in two identical writes to the same doc — not a conflict, not data loss, nothing to reconcile.

**Known limitation:** `cloudSyncTimes` (last upload/pull shown in the UI) is in-memory only and resets on reload — cosmetic, doesn't affect `lastSyncedServerTs`/the upload cursors, which are persisted in `state`.

**Known limitation: a device's first Pull reads its entire lifetime match history in one shot, which is bounded by Firestore's free-tier daily read quota (50k reads/day; each doc returned counts as one read).** `matchLog` is permanent and append-only by design (see "Merging rankings between devices") — nothing is ever compacted out of Firestore — so a brand-new device, or a from-scratch recovery (`lastSyncedServerTs === null`), pulls every item/match/tombstone doc that has ever existed, not just recent activity. At the scale this app is built for (a couple of people ranking things personally) this is a non-issue for years — even tens of thousands of lifetime comparisons is well under the daily cap — but it's worth knowing that a single from-scratch onboarding could, at a large enough lifetime match count, need to be spread across more than one day rather than completing in one Pull. No fix planned; noted here since it's a direct consequence of the never-compact design being relied on elsewhere.

**Verification status:** see the testing notes and CHANGELOG entry for 2.0.0 — this was a substantial rewrite of the sync transport and was verified via multi-device simulation (push/pull in varying orders, overlapping items ranked on both "devices," deletions on one side merging with edits on the other) before being merged. Real two-account live verification against a hosted deployment remains the final check once a second user is available to run it, same as before.

**Security rules (must be updated in the Firebase console for 2.0.0 — a code change alone doesn't do this).** The pre-2.0.0 rule only needed to cover the single `rankers/shared` document; the append-only model needs the same two-UID allowlist extended to all subcollections, including `itemUndeletes` (2.2.0) and `catDeletes`/`catUndeletes` (2.5.0):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rankers/shared {
      allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      match /items/{itemId} {
        allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      }
      match /matches/{matchId} {
        allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      }
      match /itemDeletes/{itemId} {
        allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      }
      match /itemUndeletes/{itemId} {
        allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      }
      match /catDeletes/{catId} {
        allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      }
      match /catUndeletes/{catId} {
        allow read, write: if request.auth.uid in ['<uid-A>', '<uid-B>'];
      }
    }
  }
}
```

This is a manual, one-time step in Firebase Console → Firestore Database → Rules — not something a code commit or redeploy affects (same caveat as "Expand cloud sync access beyond two users" below).

---

## ELO ranking

Standard ELO formula with K=32. When a user picks item A over item B:

```js
const K = 32;
const expected = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
winner.elo += K * (1 - expected);
loser.elo  += K * (0 - (1 - expected));
winner.wins++;
loser.losses++;
```

All items start at ELO 1000. After enough comparisons, scores naturally spread — a well-ranked list typically shows a range of ~200–400 points between top and bottom.

The leaderboard score bar is normalized: the top item always fills 100%, the bottom sits at 0%, everything else scales between them.

---

## Ranking modes

### Standard (1 vs 1)

Two random items shown side by side. Pick one. One ELO update per round. Good for deliberate, focused comparisons.

**Keyboard voting**: `handleRankVoteKey(e)` is a single `document`-level `keydown` listener (registered once) that lets you vote without clicking — `ArrowLeft`/`1` picks the left card, `ArrowRight`/`2` picks the right card. It only acts when `rankMode === 'standard'`, the Rank tab is the active view, a pair is currently loaded (`currentPair`), and focus isn't in an `input`/`textarea`/`select` (so typing in Search, an Add-item field, or the category/mode selects is never intercepted). Each `vsCard()` shows its key hint (`(← or 1)` / `(→ or 2)`) next to "Pick this" so the shortcut is discoverable without a separate help screen.

**Session counter**: `standardSessionVotes` counts comparisons made in standard mode since the category was last selected (`rank-cat`'s `onchange` resets it to 0; skipping a pair does not count). Shown next to "Which do you prefer?" once at least one vote has been cast this session — in-memory only, not persisted, and unrelated to the lifetime `Total comparisons` stat on the Data tab (which counts `wins` across all items and never resets).

### Podium

3–5 random items shown at once (pool size scales with list size — minimum 3 items required). You assign 🥇 🥈 🥉 to your top three. On confirm, ELO updates are applied for every implied pair:

- 1st beats 2nd, 3rd, and all unranked items in the pool
- 2nd beats 3rd and all unranked items
- 3rd beats all unranked items
- Unranked items are not compared against each other (no preference expressed)

With a full pool of 5 items, one podium round generates up to 9 ELO updates vs 1 for standard mode — significantly faster convergence on large lists.

ELO scores and win/loss counts are intentionally hidden during ranking (both 1v1 and Podium) to avoid anchoring bias. They remain visible in the Library and Leaderboard.

The mode toggle (1 vs 1 / Podium) is persistent within a session but not saved to localStorage — it resets to Standard on page reload. To persist it, add `rankMode` to the `state` object.

### Tier

3–30 items per session (user sets count each time). Items are assigned to S/A/B/C/D tiers by clicking coloured buttons. On confirm, every cross-tier pair generates an ELO update — items in the same tier are not compared. With 10 items this produces up to 45 ELO updates per session, making it the most efficient mode for large lists.

Pool selection prioritises items with zero comparisons first, then items with the fewest total comparisons, with the remainder filled randomly. This ensures new items surface quickly.

The skip button is hidden in Tier mode — session control is handled by the initial size prompt. Minimum 3 items required.

### Adding a new ranking mode

1. Add a button to the `.mode-toggle` in the Rank view HTML
2. Add a branch in `setRankMode()` and `initRankView()`
3. Implement a `load*()` function that renders into `#rank-pair`
4. All modes share `eloUpdate()` — call it for every implied pairwise result

---

## Tab views

| Tab | View ID | Key functions |
|---|---|---|
| Library | `view-library` | `renderLibrary()`, `renderAddForm()`, `addItem()` |
| New Category | `view-newcat` | `openNewCatModal()`, `saveNewCat()`, `addNewCatField()` |
| Schema Editor | `view-schema` | `openSchemaEditor()`, `saveSchema()`, `addSchemaField()` |
| Rank | `view-rank` | `initRankView()`, `setRankMode()`, `loadPair()`, `vsCard()`, `vote()`, `loadPodium()`, `renderPodium()`, `submitPodium()`, `loadTier()`, `submitTier()` |
| Leaderboard | `view-leaderboard` | `renderLB()` |
| History | `view-history` | `renderHistory()`, `recordRanking()`, `undoRanking()` |
| Data | `view-data` | `exportData()`, `importData()`, `uploadToFirestore()`, `pullFromFirestore()`, `renderStats()`, `renderDeletedItems()`, `undeleteItem()`, `clearAllData()` |

Tab switching is handled by `switchTab(id)`, which toggles `.active` on both nav buttons and view divs. New Category and Schema Editor are modal-style views with no nav tab — they're entered programmatically and return to Library on save or cancel.

---

## Key functions

| Function | What it does |
|---|---|
| `load()` | Reads localStorage, runs `migrateData()`, rebuilds selects, renders all views |
| `migrateData(data)` | Applies all schema version migrations in sequence; called by both `load()` and `importData()` before touching state |
| `save()` | Serializes `state` to localStorage |
| `rebuildCatSelects()` | Syncs both `<select>` elements to `state.cats` |
| `schemaFor(cat)` | Returns `{ primary, fields }` for a category, with safe defaults |
| `primaryLabel(cat)` | Returns the primary field label string for a category |
| `extraFields(cat)` | Returns the extra fields array for a category |
| `itemsForCat(cat)` | Returns a category's items with the active field filters applied, excluding hidden items; shared by Leaderboard and all three rank modes (Library uses `libItems()` instead so hidden items stay visible for un-hiding) |
| `deleteItemsInCat(cat)` | Permanently removes every item belonging to a category (no filters); used by category deletion and both import "replace" flows |
| `renderAddForm()` | Dynamically renders the Add item form based on the active category's schema |
| `addItem()` | Validates inputs, creates item at ELO 1000, saves, re-renders library |
| `deleteItem(id)` | Confirms, removes item, saves, re-renders library + leaderboard |
| `toggleHidden(id)` | Flips an item's `hidden` flag, saves, re-renders library + leaderboard + stats |
| `filteredLibraryList()` | Returns the Library's full currently-matching items for the active category — search text and field filters both applied, across all pages; `renderLibrary()` and `bulkSetHidden()` both call this so the bulk actions always act on exactly what matches, not just the visible page |
| `bulkSetHidden(hidden)` | Sets `hidden` on every item in `filteredLibraryList()` to the given value (all pages), saves, re-renders library + leaderboard + stats |
| `renderLibrary()` | Rebuilds selects + form, renders alphabetical item list paginated at `LIB_PAGE_SIZE` (2.6.0); resets to page 1 whenever the category/search/filter fingerprint changes |
| `libGoToPage(page)` | Sets the active Library page and re-renders (2.6.0) |
| `clearLibSearch()` | Empties the Library search input and re-renders (2.7.0) |
| `openNewCatModal()` | Resets pending state and switches to the new-category view |
| `saveNewCat()` | Validates name + primary label, pushes to state; also unconditionally pushes a `catUndeletes` fact for the name (2.5.0), so a (re)created category always syncs even if that name was deleted before — see "Category deletions" |
| `openSchemaEditor()` | Copies current schema into editing state, switches to schema view |
| `saveSchema()` | Writes editing state back to `state.schema`, saves |
| `confirmDeleteCat()` | Confirms with item count, deletes category + its items, saves; also tombstones the category itself in `state.catDeletes` (2.5.0) so the deletion propagates, not just its items — see "Category deletions" |
| `editItem(id)` | Toggles inline edit expansion for an item row; collapses any other open row |
| `saveItem(id)` | Validates and writes edited field values back to state, saves; if the title or an identity field's value changed the item's id, rekeys it locally and tombstones the old id (2.4.0) so the rename propagates to other devices instead of leaving a stale duplicate — see "Merging rankings between devices" known gaps |
| `initRankView()` | Entry point for the Rank tab — dispatches to `loadPair()` or `loadPodium()` based on current mode |
| `setRankMode(mode)` | Switches between `standard` and `podium` modes, updates toggle UI, reloads |
| `loadPair()` | Picks 2 random items from the active rank category, stores them in `currentPair` (for keyboard voting), renders VS cards with the running session count |
| `vsCard(winner, loser, keyHint)` | Returns HTML string for one side of a comparison card, with an optional keyboard-shortcut hint next to "Pick this" |
| `handleRankVoteKey(e)` | `document`-level `keydown` listener (registered once); votes via `ArrowLeft`/`1` (left card) or `ArrowRight`/`2` (right card) when standard mode's Rank tab is active and a pair is loaded; ignores input/textarea/select focus |
| `vote(wid, lid)` | Runs ELO update, increments `standardSessionVotes`, saves, re-renders leaderboard, loads next pair |
| `loadTier()` | Prompts for session size, assembles pool prioritising zero-comparison items, resets placements, renders |
| `renderTier()` | Renders tier lanes (S/A/B/C/D) with placed chips and untiered item list with tier buttons |
| `assignTier(itemId, tier)` | Places an item into a tier lane |
| `removeTierPlacement(itemId)` | Returns an item from a tier lane back to untiered |
| `submitTier()` | Derives all implied pairwise ELO updates from tier order (items in same tier not compared), saves, loads next session |
| `recordRanking(entry)` | Appends a ranking to `state.history` with timestamp; keeps only last 50 entries (called after each vote/podium/tier session) |
| `entryItemIds(entry)` | Returns every item id a history entry's ELO reversal would touch (winner/loser for standard, the flat `wid`/`lid` list for podium/tier) |
| `canUndo(entry)` | Returns `true` only if every id from `entryItemIds(entry)` still exists in `state.items`; used to refuse an undo up front rather than silently reversing a subset of it |
| `undoRanking(idx)` | Refuses (toast, no state change) if `canUndo()` is false; otherwise reverses ELO, wins, losses for all items involved, removes the entry from history, refreshes leaderboard and history views |
| `renderHistory()` | Renders the last 50 rankings in reverse chronological order; shows a disabled "Undo unavailable" button (via `canUndo()`) for entries referencing a deleted item instead of a clickable Undo |
| `loadPodium()` | Picks 3–5 random items for a podium round, resets placement state, renders |
| `renderPodium()` | Renders podium items with place assignment buttons; shows Confirm once 3 placed |
| `assignPlace(itemId, place)` | Assigns a podium position (1/2/3) to an item, displacing any previous occupant |
| `clearPodiumPlace(itemId)` | Removes an item's podium placement |
| `submitPodium()` | Derives all implied pairwise ELO updates from podium order, saves, loads next round |
| `eloUpdate(w, l)` | Pure ELO math, mutates winner/loser objects in place |
| `applyEloUpdate(winner, loser)` | Calls `eloUpdate()` and returns the `{wid, lid, wChange, lChange}` delta record used by `recordRanking()`/`undoRanking()`; shared by `vote()`, `submitPodium()`, `submitTier()` |
| `renderLB()` | Renders ELO-sorted leaderboard with category pills and medals |
| `itemMeta(item, useLabels?)` | Returns array of formatted field strings; auto-labels when 2+ fields populated |
| `itemMetaInline(item)` | Joins `itemMeta()` with ` · ` for single-line display in leaderboard and tier's untiered list |
| `itemMetaStacked(item)` | Renders `itemMeta()` as stacked `<span>` blocks for VS and Podium rank cards |
| `showCsvHelp()` | Toggles the CSV format guide in the Data tab |
| `importCSV(e)` | Reads a CSV file, delegates to `parsePreloadCSV()` and `resolveCSVImport()` |
| `parsePreloadCSV(text)` | Parses `#directive` header rows and data rows; returns `{ok, category, primary, fields, items}` or `{ok:false, error}` |
| `splitCSVLine(line)` | Splits a CSV line handling quoted fields with commas inside |
| `resolveCSVImport(result)` | Handles conflict resolution when category already exists — prompts for bulk add, replace, or cancel; dispatches to `bulkAddCSVImport()` or `applyCSVImport()` |
| `bulkAddCSVImport(result)` | Matches incoming items to existing ones by title (case-insensitive); updates field values on matches, preserves ELO and win/loss record; adds unmatched items fresh at ELO 1000 |
| `applyCSVImport(result, updateSchema)` | Writes parsed CSV items and optionally schema into state |
| `renderStats()` | Renders version info + item/vote counts in the Data tab |
| `itemsWithoutHidden()` | Returns a copy of `state.items` with the `hidden` key stripped from every item; used by `buildExportPayload()` so hidden status (a personal, per-browser preference) never travels in an exported file |
| `buildExportPayload()` | Builds the `_meta` + state object for file export (`exportData()`); strips `deviceId`/`userName`/`lastSyncedServerTs`, the personal per-device bookkeeping fields |
| `exportData()` | Serializes `buildExportPayload()` to JSON, triggers download |
| `cloudSignIn()` / `cloudSignOut()` | Google auth via Firebase's `signInWithPopup(GoogleAuthProvider)` / `signOut()` |
| `renderCloudAuthUI()` | Reflects current auth/availability state into the Data tab's Cloud sync card; enables/disables Upload/Pull |
| `uploadToFirestore()` | Batches per-doc writes for new/changed items, this device's new matches, and new tombstones (filtered against the local `lastUploaded*` cursors), plus a merge-write to the root doc's cats/schema; advances the cursors on success |
| `pullFromFirestore()` | Queries `items`/`matches`/`itemDeletes` for anything newer than `state.lastSyncedServerTs`, builds an `incoming` object, hands it to `mergeImport()`, advances the cursor |
| `cloudErrorMessage(e)` | Maps Firestore error codes to a plain-language toast string |
| `exportCategoryCSV()` | Exports the currently selected library category as a preload-compatible CSV with schema directives; no ELO or ranking data |
| `csvCell(val)` | Escapes a value for CSV output — wraps in quotes if it contains commas, quotes, or newlines |
| `importData(e)` | Reads JSON file, runs `migrateData()`, hands off to `mergeImport()` |
| `mergeImport(incoming)` | Unconditional set-union merge — see "Merging rankings between devices" above; also unions `catDeletes`/`catUndeletes` and purges any newly-tombstoned category's name/schema/items before unioning in (2.5.0 — see "Category deletions") |
| `unionItemsAndSchema(incoming, tombstoneIds, tombstonedCats)` | Adds items/cats/schema fields only present in `incoming` (skipping any id in `tombstoneIds` or any category in `tombstonedCats` — 2.5.0), defaulting `elo`/`wins`/`losses` to `1000`/`0`/`0` if `incoming` doesn't carry them (Firestore item docs never do — see "Cloud sync"); last-write-wins on shared items' `fields` via `updatedAt`; returns the ids of items just created *whose incoming payload carried a real `elo`* as `freshlySeeded` (2.0.3 — a Firestore-sourced new item never carries one, so it's never marked fresh and its matches are always applied), used by `mergeImport()` to avoid double-counting matches already baked into a file-imported item's rating |
| `applyNewMatches(newMatches)` | Sorts `newMatches` by `(ts,seq)` and applies each directly onto whatever live item ratings are already in `state.items` via `eloUpdate()` — never resets/replays from scratch, since `state.matchLog` isn't guaranteed to be a device's complete history (see "Merging rankings between devices") |
| `dedupeById(list)` | Dedupe helper for a `matchLog` against itself, by `.id` |
| `latestByKey(list, keyOf)` / `latestPerItemId(list)` / `latestPerCat(list)` | `latestByKey()` reduces a delete/undelete list to one entry per key (max `ts`); `latestPerItemId()`/`latestPerCat()` are thin wrappers keyed by `itemId`/`cat` respectively (2.5.0 — generalized when category tombstones needed the identical reduction) — see "Item deletions"/"Category deletions" |
| `currentlyTombstonedKeys(deletes, undeletes, keyOf)` / `currentlyTombstonedIds(deletes, undeletes)` / `currentlyTombstonedCats(deletes, undeletes)` | A key (item id or category name) is tombstoned iff its latest delete is newer than its latest undelete (ties favor deleted); `currentlyTombstonedIds()`/`currentlyTombstonedCats()` are `keyOf` wrappers (2.5.0) — see "Item deletions"/"Category deletions" |
| `recordMatch(cat, wid, lid)` | Appends one permanent entry to `state.matchLog`, namespaced by `settings.deviceId` so two devices' match ids never collide |
| `deleteItem(id)` / `deleteItemsInCat(cat)` | Confirms, removes item(s), appends a tombstone per removed item to `state.itemDeletes` — see "Item deletions" above |
| `undeleteItem(itemId)` | Pushes an "undo a delete" fact to `state.itemUndeletes`, timestamped strictly after the delete it targets — does not restore the item's data/rating, only clears the sync block going forward — see "Item deletions" |
| `itemKey(cat, title, identitySuffix = '')` | Deterministic hash of `(cat, title, identitySuffix)` — the item id scheme since schema v4; `identitySuffix` defaults to `''` (byte-identical to the pre-2.1.0 hash) unless the category has identity fields — see "Item identity fields" |
| `catKey(cat)` | Deterministic hash of a category name (2.5.0), same algorithm as `itemKey()` with a `'c'` prefix instead of `'i'` — used as the Firestore doc id for `catDeletes`/`catUndeletes` since a raw category name isn't guaranteed to be a valid doc id — see "Category deletions" |
| `identitySuffixFor(cat, fields)` / `identitySuffixForFields(idFields, fields)` | Builds `itemKey()`'s third argument from whichever schema fields are flagged `identity: true`, sorted by field name, values normalized like title (`trim().toLowerCase()`). The `Fields` variant takes an explicit field list (used by `saveSchema()`'s pending-rekey check against not-yet-saved `editingFields`); the other reads the category's saved schema. Every id-computing call site goes through one of these — see "Item identity fields" |
| `remapItemIds(idMap)` | Rekeys `state.items`/`matchLog`/`itemDeletes`/`history` per `{oldId: newId}` — same remap shape as the v4 migration that introduced `itemKey()`; used by `rekeyItemsForIdentityFields()` (see "Item identity fields") |
| `rekeyItemsForIdentityFields(cat, pendingIdFields)` | Recomputes every item's id in `cat` under `pendingIdFields`, applies via `remapItemIds()` if no two items collide, else returns `{collision}` without changing anything — shared by `saveSchema()` (interactive) and `adoptIncomingFields()` (sync-triggered), see "Item identity fields" (2.3.0) |
| `adoptIncomingFields(cat, incomingFields)` | For a category this device already knows: adds any field it's never heard of wholesale (2.5.1, no rekey needed), and monotonically adopts any `identity: true` an already-shared field newly has (2.3.0, never removes one) — commits the identity change only if `rekeyItemsForIdentityFields()` succeeds; `required`/`filterable` on an already-shared field stay local-only — see "Item identity fields" |
| `freshState()` | Returns a brand-new empty `state` object with all fields (including a fresh `deviceId`) — used by the initial `let state = freshState()` and by `clearAllData()`, so both start from the exact same shape |
| `clearAllData()` | Confirms, resets state to `freshState()`, clears localStorage |
| `uid()` | Generates a short collision-resistant ID — legacy fallback, no longer used by the sync/merge system as of 2.0.0 |
| `esc(s)` | HTML-escapes strings before injecting into innerHTML |

---

## How to expand

### Add a new built-in category

Add an entry to `CAT_DEFAULTS` at the top of the script:

```js
const CAT_DEFAULTS = {
  'Movies': { ... },
  'Songs':  { ... },
  'Restaurants': {
    primary: 'Name',
    fields: [
      { name: 'Cuisine', required: false },
      { name: 'City', required: false }
    ]
  }
};
```

Also add to `BUILTIN_CATS` if you want it protected from deletion (currently all keys of `CAT_DEFAULTS` are built-in).

### Search the library

Real-time search across item titles and all field values. The Library view includes a search card with a text input that filters the list as you type.

**Implementation**:
- Search input with id `lib-search` in the library card
- `renderLibrary()` reads the input value and applies case-insensitive substring matching
- Searches both item `title` and all values in `item.fields`
- Shows "No items match X" when no results
- Search clears when switching categories (for UX clarity)
- A "✕" clear button (`#lib-search-clear`, 2.7.0) sits inside the input via `.search-wrap` positioning; `renderLibrary()` shows/hides it based on whether `query` is non-empty, and `clearLibSearch()` empties the input and re-renders on click

**How it works**:
```js
const query = document.getElementById('lib-search')?.value.toLowerCase().trim() || '';
if (query) {
  list = list.filter(i => {
    if (i.title.toLowerCase().includes(query)) return true;
    const itemFields = i.fields || {};
    return Object.values(itemFields).some(v => String(v).toLowerCase().includes(query));
  });
}
```

**Use cases**: Find all movies by director, all books from a year, all restaurants of a cuisine type.

### Library pagination (2.6.0)

The Library list is paginated at `LIB_PAGE_SIZE` (50) items per page to avoid the render-flicker cost of rebuilding a huge `innerHTML` list every keystroke — see "Known limitations & performance thresholds" below.

**Implementation**:
- `renderLibrary()` slices the result of `filteredLibraryList()` (search + field filters already applied to the *entire* matching set) down to the current page — filtering/searching logic itself is untouched, only what's rendered changes
- A fingerprint of `(cat, query, filterState[cat])` is computed each render and compared to the previous render's; when it differs, the page resets to 1 — this is what makes changing the search term or a field filter always land back on page 1 of the new results, from any page
- The page number is clamped to the valid range every render, so deleting/hiding items that shrinks the list below the current page can't strand the view
- Editing an item in place doesn't change the fingerprint, so the current page is preserved while editing
- Prev/Next controls plus a "Page X of Y (Z items)" indicator render below the list only when there's more than one page
- Bulk hide/unhide (`bulkSetHidden()`) is unaffected by pagination — it still calls `filteredLibraryList()` directly and acts on every matching item across all pages, not just the visible page (see below)

### Add structured field filtering

Field-based filtering allows ranking subsets of items by their extra fields. Items are filtered before being shown in the Library view, Leaderboard, and all ranking modes (VS, Podium, Tier).

**Architecture**:
- `filterState = {}` — global object tracking active filters per category: `{ [category]: { [fieldName]: { type, values, min, max, equals, nonBlank } } }`
- `fieldTypeCache = {}` — caches type inference results to avoid re-scanning on every filter change
- `filterCollapsed = {}` — tracks collapse state of filter section per category (defaults to collapsed)

**Key functions**:
- `inferFieldType(cat, fieldName)` — scans up to 20 non-empty values; if ≥80% are numeric, classifies as `"number"`, else `"string"` (categorical)
- `getFilteredItems(cat, items, filters)` — applies all active filters with AND logic; numeric fields check `min`/`max`/`equals`; categorical fields check multi-select values; `nonBlank` (if set, on either field type) excludes items where the field is `undefined` or `""`, independent of the type-specific condition
- `renderFilterUI(cat)` — builds the field cards once via `buildFilterFieldCards(cat, fields, catFilters)`, then renders them into both `lib-filters` and `rank-filters` via `buildFilterPanel(cat, filterId, ...)`, passing each container its own directly-embedded id (`filter-fields-<cat>-lib` / `-rank`) so the two copies never share DOM ids
- `buildFilterFieldCards(cat, fields, catFilters)` — generates the per-field filter cards; skips fields where `filterable === false`; numeric fields show min/max/exact inputs plus a "Has value" checkbox; categorical fields show checkboxes for all unique values plus the same "Has value" checkbox
- `buildFilterPanel(cat, filterId, isCollapsed, activeCount, fieldsHtml)` — wraps a set of field cards with the collapsible header (chevron, active-filter count, "✕ Clear" button) and the collapse-toggle target div
- `updateFilter(el)` — onclick handler for filter inputs; distinguishes the "Has value" checkbox (`data-op="nonblank"`) from categorical value checkboxes (`data-value`) via the `data-op` attribute; updates `filterState[cat]` and re-renders affected views
- `resetFilters(cat)` — clears filters for a category and re-renders filter UI
- `clearAllFilters(cat)` — clears all active filters when user clicks "✕ Clear" button
- `toggleFilterable(i)` — toggles the `filterable` flag for a field in the schema editor

**Integration points**:
- `renderLibrary()` calls `filteredLibraryList()`, which applies `getFilteredItems(cat, list, filterState)` (plus search) before displaying items
- `loadPair()`, `loadPodium()`, `loadTier()` all apply `getFilteredItems()` to their item pools
- `renderLB()` applies filters to the leaderboard display
- `bulkSetHidden(hidden)` (the Library's "Hide/Unhide all shown" toolbar) also calls `filteredLibraryList()`, so bulk hide/unhide always matches the currently filtered + searched set

**UI/UX**:
- Filter section collapses by default (shows just the header with a ▶ chevron) to save screen space
- Clicking the filter header toggles expand/collapse (chevron changes to ▼)
- Collapse state is independent per container (lib vs rank) — each renders with a unique div ID (`filter-fields-lib-Movies` vs `filter-fields-rank-Movies`)
- Shows count of active filters in the header (e.g., "Filter 2")
- Filters persist across tab switches for the same category but clear when switching to a different category

**Design notes**:
- Type inference is deterministic for a given category — same field always gets same type across sessions (within `fieldTypeCache`)
- Filters are session-specific and not persisted to localStorage — simpler UX, no stale filter state
- Numeric fields use three separate inputs (min/max/exact) rather than a single operator dropdown — clearer semantics
- Filters hidden items entirely rather than dimming them — no confusion about why they appear in leaderboard but not ranking
- Filter logic is applied consistently: all filtering functions call `getFilteredItems()` to avoid drift
- Each field has a `filterable` property (defaults to `true`) that controls whether it appears in the filter UI; set to `false` for fields like URLs, IDs, or notes that are not meaningful for filtering
- Filterable toggle is accessible in the Fields editor (⚙ button in Library tab) — users can click 🔍 to toggle between filterable and non-filterable state
- "Has value" is a type-agnostic toggle (one checkbox per field, shown on both numeric and categorical cards) rather than a synthetic "(blank)" option folded into the categorical checklist — keeps the same control available uniformly for every field type
- `getFilteredItems()` treats a field's filter as "active" only when a type-specific condition is set (`min`/`max`/`equals` for numeric, non-empty `values` for categorical) or `nonBlank` is checked; fields with no active condition are skipped entirely, so items with a blank value are no longer excluded by a field that has no filter applied

### Add notes/tags to items

Extend the item object with `notes: string` and `tags: string[]`. Add inputs in `renderAddForm()`. Filter by tag in the library view. Tags could also drive a new "browse by tag" view.

### Hide items from ranking

Items carry a `hidden: boolean` field (default `false`). Toggled per item in the Library via the ◎/◉ button next to Edit/Remove — `toggleHidden(id)` flips the flag, saves, and re-renders.

Hidden items stay visible in the Library (dimmed via `.item-row.is-hidden`, tagged with a "hidden" badge) so they can be found and un-hidden, but `itemsForCat()` filters them out — since Leaderboard and all three rank modes (VS, Podium, Tier) source their item pool from `itemsForCat()`, hidden items never appear there. `libItems()` (Library's own item source) is untouched, so hiding never removes an item from view, only from ranking/leaderboard consideration.

A bulk toolbar above the item list ("Hide all matching (n)" / "Unhide all matching (n)", renamed from "…all shown…" in 2.6.0 once the list became paginated) applies `bulkSetHidden(hidden)` to every item in `filteredLibraryList()` — the same search + field-filter-applied set the list itself renders, spanning all pages, not just the currently visible one. This lets a user filter down to a subset (e.g. `Director: Wachowski`, or a search term) and hide or unhide the whole matching set in one click, without touching anything outside it — regardless of how many pages that set spans.

No data migration was needed: old items simply lack the `hidden` field, and `!i.hidden` treats `undefined` the same as `false`.

`hidden` is treated as a personal, per-browser preference rather than shared library data, since users regularly pass exported JSON back and forth and don't want their hidden set imposed on each other:
- `exportData()` calls `itemsWithoutHidden()` to strip the `hidden` key from every item before serializing, so exports never carry it
- `importData()` forces `hidden: false` on every incoming item regardless of what the file contains, so importing (or hand-editing a file) can't set it either
- CSV import/export never touches `hidden` at all (it only ever dealt with the primary field + schema fields), so this only needed handling on the JSON path

### Extend the CSV preload format

The CSV parser reads `#category`, `#primary`, and `#field` directives. To add new directives (e.g. `#description` for a category description):
1. Add a new `else if (directive === 'description')` branch in `parsePreloadCSV()`
2. Store the value in the result object
3. Apply it in `applyCSVImport()`

### Smart pair selection

The Rank tab includes an optional **Smart pairing** toggle that changes how items are selected for comparison. When enabled, instead of picking two completely random items (which often results in lopsided matchups), smart pairing sorts items by ELO and picks two adjacent items — guaranteeing they have similar ratings and the outcome is uncertain.

**Implementation**: 
- `smartPair(list)` — sorts by ELO, picks a random position idx, returns `[sorted[idx], sorted[idx+1]]`
- `randomPair(list)` — original random logic, used when toggle is off
- Applied to all three ranking modes: VS (`loadPair`), Podium (`loadPodium`), and Tier (`startTierSession`)
- Toggle is stored in `smartPairMode` flag and synced via `toggleSmartPair(enabled)`

**Effect**: Convergence is faster (fewer uninformative blowouts), especially with large item pools (50+). Random mode is still the default — smart pairing is opt-in.

**Extending**: To make the toggle persist across sessions, add `smartPairMode` to the `state` object and sync it in `save()`/`load()`. Currently it resets to `false` on page reload.

### Switch from localStorage to a backend

Replace `save()` and `load()` with `fetch()` calls to a REST API or serverless function. The state shape is already JSON-serializable — no transformation needed. Suggested stack: Node/Express or a Cloudflare Worker with KV or SQLite.

### Port to a framework

The app is intentionally framework-free. If porting to React or Vue:
- `state` → `useState` or a Pinia/Zustand store
- Each `render*()` function → a component
- `save()`/`load()` → a custom hook or store plugin

### Host it online

Because it's a single HTML file, it deploys anywhere static files are served:
- **GitHub Pages**: push the file, enable Pages in repo settings
- **Netlify / Vercel**: drag and drop the file in their dashboards
- **Cloudflare Pages**: same drag-and-drop flow

For two-or-a-few people, the app now has two sync transports that both go through the same merge pipeline: the export/import file flow (see "Merging rankings between devices") for a manual hand-off, and Firestore (see "Cloud sync" below) for an in-app Upload/Pull button instead of passing files around. Neither is live/real-time sync — both are "sync whenever someone decides to."

### Expand cloud sync access beyond two users

Deliberately out of scope for now (this app is built around "a couple of people ranking things together"), but noted here so the tradeoff isn't re-litigated from scratch if it comes up later.

**Current model:** the Firestore security rule hardcodes the two authorized UIDs directly in the rule text (`request.auth.uid in ['<uid-A>', '<uid-B>']`). Adding a person means editing and redeploying that rule in the Firebase console — manual, and not something that can be done from the app or from a code commit, since it's config that lives in Firebase, not in `index.html`.

**If you occasionally add a few more people:** switch the rule to check an **allowlist collection** instead of a hardcoded list — `exists(/databases/$(database)/documents/allowlist/$(request.auth.uid))`. Granting access then becomes "add a document to that collection" (doable from the Firestore console's data view, or a small admin UI in the app later) rather than editing rule syntax each time. Still a manual, one-at-a-time step, but lower-friction and lower-risk than touching the rule itself.

**If you want self-serve growth (anyone can sign up and join):** that's a different shape of application, not a tweak. The single-shared-document model (one `rankers/shared` doc) doesn't scale to multiple independent groups — it would need per-group documents, a real invite/join flow, and rules scoped per-group rather than per-app. Worth treating as a from-scratch redesign of the sync layer if that need materializes, not an incremental change to what exists today.

---

## Design decisions & tradeoffs

| Decision | Why | Alternative |
|---|---|---|
| Single HTML file | Zero setup, trivially shareable | Multi-file with a bundler |
| localStorage | No server needed | IndexedDB (larger data), backend |
| ELO scoring | Well-understood, self-balancing | TrueSkill, simple win-count |
| Random pair selection | Simple, covers the space over time | Smart pair selection (pick closest ELO) — now available as optional toggle |
| Vanilla JS | No build step, easy to read and edit | React/Vue/Svelte |
| JSON export | Human-readable, re-importable, version-stamped | CSV, binary |
| Schema per category | Flexible, user-defined fields | Hardcoded fields per type |
| Multiple ranking modes | 1v1, Podium, Tier — different speeds and batch sizes | Single mode only |
| ELO hidden during ranking | Prevents anchoring bias during comparison | Always visible |
| Stacked fields in rank cards and library rows | Readable with many attributes; avoids horizontal overflow with long values | Single line, cramped |
| CSV preload format | Easy to author in a spreadsheet | JSON only |
| CSV export (library only) | Share base data without rankings; recipient starts fresh | Export full JSON only |
| Inline editing | Edit without leaving the library view | Separate edit screen |
| History with undo | Recover from mistakes; reflect on choices; cap at 50 entries (~2KB per entry) to avoid localStorage pressure | No undo, or unbounded history with performance cost |
| Hide items (vs. delete) | Reversible way to exclude items (e.g. duplicates, retired entries) from ranking without losing their ELO/history | Delete permanently, or a separate archive tab |
| Deterministic item ids (`itemKey(cat, title, identitySuffix)`) | Two devices agree on the same id for "the same" item with zero coordination — no identity-matching/remap step needed to merge. Optional identity fields (2.1.0) extend this to let same-titled items stay distinct (e.g. two "Dune" movies by Year) without breaking that zero-coordination property, since the disambiguating value is real data both devices already agree on | Random ids + title-based matching/remapping at merge time; a random/counter-based disambiguator suffix instead of identity fields (would break the zero-coordination guarantee — two devices independently adding "the same" duplicate-titled item would get different ids) |
| Append-only matches/tombstones, unioned by id, applied as incremental deltas onto live ratings (2.0.0, corrected in 2.0.1) | No baseline/ancestry classification step to get wrong (the root cause of three real merge bugs in a row); push/pull become order-independent; unlike a from-scratch replay, doesn't assume `matchLog` is a device's complete history (2.0.0 briefly did, causing a real data-loss incident — see "Merging rankings between devices") | Snapshot baseline + incremental match log (the pre-2.0.0 design — bounded replay cost, but repeatedly buggy in practice); full replay-from-scratch (2.0.0's first cut — simpler-looking but broke on upgrade) |
| Merges never prompt — union is always unambiguous | Nothing is ever overwritten or compacted, so there's no case where the "right" resolution is unclear; removes an entire class of confirm-dialog misclicks (the exact failure mode of the old `diverged` prompt) | Prompt when a `diverged`/ambiguous case is detected (the pre-2.0.0 design) |
| Item deletions are tombstoned, field edits stay last-write-wins | Deletion had an actual documented failure mode (resurrection on merge); field edits don't — matching the fix to the real problem instead of over-engineering both | Track all edits as replayable events too |
| Undelete as a parallel synced log (`itemUndeletes`), resolved by latest-`ts`-per-itemId against `itemDeletes` (2.2.0) | Deterministic ids + an unconditional tombstone meant delete-then-recreate of "the same" item was permanently blocked from syncing — a real incident, not hypothetical. Reduces to one entry per itemId (max `ts`) on each side, so it needs no per-event unique ids, no migration, no `DATA_SCHEMA_VERSION` bump | A local-only "strip this tombstone" tool (doesn't auto-propagate — still requires the same manual per-device/per-Firestore cleanup the actual incident needed); giving every delete/undelete event a unique id to support full history (unnecessary complexity — only the latest fact of each type per item is ever needed) |
| Firestore for cloud sync, loaded via CDN (not npm) | Free tier, real per-user security rules, zero server code to write/host, fits the zero-build-step single-file design | Custom backend, GitHub Gist + embedded token |
| Firestore stores one document per fact (item/match/tombstone), not a JSON blob (2.0.0) | Doc-ID-keyed writes are naturally idempotent, so push/pull don't need to happen in any particular order; also sidesteps Firestore's array-in-array restriction (Tier-mode history) without a JSON-string workaround | Single JSON-string blob document (the pre-2.0.0 design) |

---

## Known limitations & performance thresholds

### Rendering

`renderLibrary()` and `renderLB()` rebuild the entire list via `innerHTML` on every update. `renderLibrary()` is paginated (2.6.0, `LIB_PAGE_SIZE` = 50 — see "Library pagination" above), which caps its per-render DOM cost regardless of category size; `renderLB()` (Leaderboard) is not yet paginated. Overall this is fine up to ~500 items per category. Beyond that:

| Items per category | Symptom | Fix |
|---|---|---|
| < 500 | No issues | — |
| 500–2,000 | Render flicker on slower devices (Leaderboard only — Library is paginated) | Paginate `renderLB()` too, or add virtual scrolling ([clusterize.js](https://clusterize.js.org/) drops in with minimal changes) |
| 2,000–10,000 | localStorage pressure + slow renders | Switch to IndexedDB + virtual scroll |
| 10,000+ | Both | Backend + virtual scroll |

For a personal ranker this is unlikely to be a real concern — even a very dedicated user would struggle to hit 500 items in a single category.

### localStorage cap

Browsers limit localStorage to ~5MB. At ~500 bytes per item that's roughly 10,000 items before issues arise. The limit comes sooner if you add notes, tags, or other large fields. Fix: switch to IndexedDB (same browser, async API, much higher limits).

### Random pair selection

The current algorithm picks two random items independently. This has two side effects: the same pair can appear twice in a row, and it can select uninformative matchups (e.g. a 1400-ELO item vs a 600-ELO item whose outcome is already predictable). With small lists this is noticeable; with large lists it means thousands of votes are needed before rankings stabilize. See "Smart pair selection" above.

### Undo for rankings

Undo is now available for rankings (Standard/Podium/Tier) via the History tab — users can reverse any ranking and restore ELO scores. However, deletions of items are still permanent (there's a confirm prompt, but no undo stack). To enable undo for deletions: implement soft-delete with a `deleted: true` flag and a "Recently deleted" view.

Deleting an item or an entire category (`deleteItem()`, `confirmDeleteCat()`/`deleteItemsInCat()`) does not touch `state.history` — past ranking entries can end up referencing ids that no longer exist in `state.items`. `canUndo(entry)` guards against this: it checks that every id an entry's reversal needs is still present before allowing `undoRanking()` to proceed, and `renderHistory()` shows a disabled "Undo unavailable" button for any entry that fails the check. This was a deliberate fix for a real bug — the previous implementation reversed whichever pairs in an entry still had both items present and silently skipped the rest, so a podium/tier entry with one deleted item would leave the *other* items' ELO/wins/losses partially reverted while still reporting "Undo complete" and discarding the history entry, with no way to detect or correct it afterward. The entry itself is left in history (not auto-removed or purged on deletion) so it's still visible for context; it ages out naturally once the 50-entry cap is exceeded.

### Single-user (device-local by default, mergeable on demand)

Data is local to one browser profile. As of schema v4, exporting/importing JSON between two devices merges rankings automatically (see "Merging rankings between devices") rather than requiring a full Replace, and as of 1.17.0 there's also an optional Firestore-backed Upload/Pull button (see "Cloud sync") so that merge doesn't require passing a file by hand. Both are still "sync whenever someone clicks the button," not live/real-time sync across open tabs.

**Known gaps in the merge model** (acceptable tradeoffs, worth knowing about):
- **Deletions are now tracked (fixed in 2.0.0/schema v6).** Previously there was no tombstone log — a locally-deleted item still present in an incoming file would come back on merge. `state.itemDeletes` closes this; see "Item deletions" above. No known gap remains here.
- **A single-item rename (title edit, or since 2.1.0 an identity field's value edit) orphans local `matchLog`/`history` on the *renaming* device itself (accepted gap) — but now correctly propagates to *other* devices (fixed in 2.4.0).** Since id = `itemKey(cat, title, identitySuffix)`, changing either changes the id. On the device making the edit, `saveItem()` does a simple local rekey (not the full `remapItemIds()` treatment `saveSchema()`'s bulk rekey gets) — so that device's own `matchLog`/`history` entries pointing at the old id become orphaned locally (silently inert, no `applyNewMatches()`/`canUndo()` match). This is deliberately left as-is: the blast radius is one item, not a whole category, so the full remap treatment wasn't judged worth the extra weight on every single edit.
  - **What *did* need fixing:** before 2.4.0, the rename never told *other* devices anything — the old id's Firestore doc was simply left in place untouched, so any device that already had a copy under the old id kept it forever, and the new id arrived as a separate item. Real report: editing a Song's title left both the old- and new-titled entries on the other device after the next sync — a real, visible duplicate, not just an inert matchLog reference. Fixed by having `saveItem()`'s rekey branch push a tombstone for the old id (`state.itemDeletes`), exactly like `deleteItem()` already does — `mergeImport()`'s existing tombstone handling (see "Item deletions") then retires the stale copy on any device that pulls it, for free, no new sync mechanism needed.
  - **Tradeoff this reintroduces, and why it's now safe:** renaming something *back* to a title/identity-value it used to have will hit the same tombstone-blocks-recreation trap as any other delete (see "Item identity fields" → the Superman incident) — but that trap now has a real fix (Undelete), so the cost of reusing the tombstone mechanism here is much lower than it would have been before 2.2.0.
  - The *bulk* version of a rename — toggling which fields are identity for a whole category via the Schema Editor — remains handled differently and more thoroughly via `remapItemIds()`, which keeps local `matchLog`/`history` consistent directly rather than via a tombstone (see "Item identity fields"); this section's gap is specific to the single-item edit path.
- **Replay order across two devices' interleaved matches isn't reconstructed globally (accepted tradeoff, not a bug).** `mergeImport()` always fully replays the union of both matchLogs sorted by `(ts, seq)` — deterministic and never drops a match, but client clocks can disagree and `seq` is only comparable within one device's own log, so the exact ELO trajectory two people would have seen ranking in true real-time isn't guaranteed to match. See "Merging rankings between devices" above.
- **`settings.userName` is a deferred stub.** Added alongside `deviceId` (schema v4) but not wired into any UI — nothing reads or displays it yet. `deviceId` alone already guarantees match-id uniqueness, which was the actual technical requirement; `userName` was reserved for later human-readable attribution (e.g. on history entries) but deliberately deferred until that's actually needed. It is stripped from exports the same way `deviceId` is.

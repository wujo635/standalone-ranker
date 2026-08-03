# Ranker — Architecture & Developer Guide

A single-file web app for ranking anything using pairwise ELO comparisons. Categories are fully user-defined with custom fields. No build step, no dependencies, no server required.

---

## Quick start

Open `index.html` in any modern browser. That's it.

---

## Current versions

| | Value |
|---|---|
| App version | `2.0.0` |
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
├── <style>       CSS custom properties + all component styles (~130 lines)
├── <body>        Seven views: Library, New Category, Schema Editor, Rank, Leaderboard, History, Data
└── <script>      All app logic (~980 lines of vanilla JS)
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
        { name: 'Year', required: false, filterable: true },
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
      id:        string,   // itemKey(cat, title) — deterministic hash, e.g. "i1en785j". Two
                            // devices adding "the same" item independently land on this same
                            // id, so merging never needs an identity-matching/remap step.
                            // Renaming an item's title changes its id (see itemKey()).
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

  // Append-only, permanent log of every pairwise result this device knows about — never
  // compacted or reset, separate from `history` (which is capped at 50, display/undo
  // only). This is the sole source of truth for ratings: replayAllMatches() recomputes
  // every item's elo/wins/losses from scratch by folding matchLog forward in (ts, seq)
  // order. mergeImport() unions two matchLogs by id and re-replays — see "Merging
  // rankings between devices" below.
  matchLog: [
    { id: string, cat: string, wid: string, lid: string, ts: number, seq: number }
  ],

  // Append-only, permanent log of deletion tombstones — the same "never compact, union
  // by id" treatment as matchLog, but for item removals. A tombstone always wins over an
  // item doc for the same id on merge, regardless of arrival order. See "Item deletions"
  // below.
  itemDeletes: [
    { itemId: string, ts: number, deviceId: string }
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

`mergeImport(incoming)` does, in order:
1. **Union tombstones** — `state.itemDeletes` and `incoming.itemDeletes` combined, deduped by `itemId`. Any item whose id is now tombstoned is deleted locally if still present, *before* items are unioned in, so an incoming copy that doesn't yet know about a delete can't resurrect it. See "Item deletions" below.
2. **Union items** — new items (not in `tombstoneIds`) are added unconditionally (deterministic ids make this collision-free); items both sides already have use last-write-wins on `fields` via `updatedAt` (title never conflicts — a title edit changes the item's id, see `itemKey()`).
3. **Union matches** — `state.matchLog` and `incoming.matchLog` combined, deduped by match `id` (already globally unique via `settings.deviceId` namespacing).
4. **Replay from scratch** — `replayAllMatches()` resets every current item to `{elo:1000, wins:0, losses:0}` and folds the *entire* merged `matchLog` forward in `(ts, seq)` order via `eloUpdatePure()`. No baseline, no partial replay — always the full history, every time.

This is safe and idempotent by construction: importing/pulling the same file twice is a no-op the second time (nothing new to union), and it doesn't matter what order two devices push/pull in, because nothing is ever overwritten — only added to. `hidden` continues to never travel in either direction (personal per-browser preference, stripped on export and forced to `false` on any newly-adopted item).

**Known, accepted tradeoff — replay order across two devices' interleaved matches isn't reconstructed globally.** `replayAllMatches()` sorts the *merged* `matchLog` by `(ts, seq)` and replays it once, which is deterministic and safe (every match still counts exactly once, nothing is ever dropped) but isn't necessarily "what the ELO would have been had these two people voted in true wall-clock real time on a shared list" — client clocks can disagree, and `seq` is only comparable within one device's own log. This is fine for the app's actual goal (no data loss, same result no matter what order devices sync in) and is a much simpler, more robust property than the old baseline/ancestry system ever guaranteed in practice.

**Why not this from the start:** the original schema-v4 design (baseline snapshot + incremental match log) was built to bound replay cost to "comparisons since the last sync," not lifetime volume — reasonable-looking on paper, but the actual cost was a steady stream of client-side reconciliation bugs, because "which snapshot is ahead" is a surprisingly easy question to get subtly wrong. Full replay-from-scratch on every merge is simpler, has no classification step to get wrong, and is cheap enough at realistic two-person casual-ranking volumes (see "Known limitation" under Cloud sync) that the bounded-replay optimization wasn't worth what it cost in fragility.

### Item deletions

Deletion is tracked the same way matches are — a permanent, replayable fact, not a silent local-only mutation. Previously (pre-2.0.0) deletions weren't tracked at all: deleting an item locally and later merging with a device that still had it just brought it back, with no way to detect or prevent that.

- `deleteItem(id)` and `deleteItemsInCat(cat)` both append a tombstone `{ itemId, ts, deviceId }` to `state.itemDeletes` in addition to removing the item from `state.items` — the same pattern `recordMatch()` already uses for `state.matchLog`.
- `mergeImport()` unions tombstones from both sides by `itemId` first, then removes any newly-tombstoned item locally *before* unioning items in — see "Merging rankings between devices" above.
- A tombstone always wins over an item doc for the same id, regardless of arrival order — deletion is permanent, there is no un-delete path (consistent with the existing local-delete confirm, which also has no undo).
- Deliberately **not** extended to field edits (title/fields changes) — those stay last-write-wins via `updatedAt`. Low collision risk, low stakes if it does collide, and full edit-history replay isn't something this app needs. Deletion got the tombstone treatment because it was the one case with an actual, documented failure mode (item resurrection on merge).
- Firestore's `itemDeletes` subcollection needs the same two-UID security rule as `items`/`matches` — see "Cloud sync" below.

### Cloud sync (Firestore)

An optional second transport alongside the file export/import flow above — same `mergeImport()` union-by-id pipeline either way, just a different way to move facts between two devices. The Data tab's "Cloud sync" card adds Upload/Pull buttons next to the existing file Export/Import controls; neither replaces the other.

**Firestore is a real append-only log, not a blob (as of 2.0.0).** Previously the entire `state` was serialized to one JSON string stored in a single document — simple, but it meant the client-side merge logic had to reconcile two full snapshots on every sync, which is exactly the fragility that produced three real bugs in a row (1.17.1, 1.18.0, 1.18.1). As of 2.0.0, Firestore itself holds one document per fact:

- `rankers/shared` (root doc) — small, low-churn blob: `{ cats, schema, updatedAt, updatedBy }`
- `rankers/shared/items/{itemId}` — one doc per item: `{ cat, title, fields, updatedAt, syncedAt }`. No elo/wins/losses stored here — ratings are always derived locally via `replayAllMatches()`, never synced directly.
- `rankers/shared/matches/{matchId}` — one doc per pairwise comparison, ever: `{ cat, wid, lid, ts, seq, syncedAt }`
- `rankers/shared/itemDeletes/{itemId}` — one tombstone doc per deleted item: `{ itemId, ts, deviceId, syncedAt }`

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

**Upload only pushes what this device hasn't already pushed**, tracked via local per-device cursors in `state.settings`: `lastUploadedItemsAt` (compared against each item's `updatedAt`), `lastUploadedSeq` (compared against this device's own match `seq`, filtered by the `settings.deviceId` prefix on match ids — matches pulled in from elsewhere don't need pushing back), and `lastUploadedDeletesAt` (compared against each tombstone's `ts`). All three advance after a successful `batch.commit()`. This bounds upload cost to "what's new," not the whole history's write count — Firestore bills per document write, so re-writing everything every time would both cost more and be pointless now that writes are idempotent anyway.

**Pull only fetches what's new since `state.lastSyncedServerTs`**, a local cursor (`null` on a fresh device, so the first pull fetches everything). Each subcollection doc carries a `syncedAt: serverTimestamp()` field used only for this — `pullFromFirestore()` queries `where('syncedAt', '>', cursor)` on `items`/`matches`/`itemDeletes`, unions the results in via `mergeImport()`, then advances the cursor to the newest `syncedAt` seen.

**Key functions:**
- `cloudSignIn()` / `cloudSignOut()` — Google auth via `signInWithPopup(GoogleAuthProvider)`
- `renderCloudAuthUI()` — reflects auth state into the Data tab card; enables/disables Upload/Pull
- `uploadToFirestore()` — batches new/changed items, this device's new matches, and new tombstones into per-doc writes (keyed by their own id, so re-sending is a safe no-op) plus a merge-write to the small root doc; advances the local upload cursors on success
- `pullFromFirestore()` — queries `items`/`matches`/`itemDeletes` for anything newer than `state.lastSyncedServerTs`, builds an `incoming` object matching `mergeImport()`'s expected shape, merges it in, advances the cursor
- `cloudErrorMessage(e)` — maps Firestore error codes (`permission-denied`, `unavailable`) to a plain-language toast

**Push and pull can happen in any order, any time, from either device — no pre-pull-before-push workaround needed (unlike the pre-2.0.0 blob design).** Because every doc is keyed by its own fact's id, two devices independently pushing "the same" match or item just results in two identical writes to the same doc — not a conflict, not data loss, nothing to reconcile.

**Known limitation:** `cloudSyncTimes` (last upload/pull shown in the UI) is in-memory only and resets on reload — cosmetic, doesn't affect `lastSyncedServerTs`/the upload cursors, which are persisted in `state`.

**Verification status:** see the testing notes and CHANGELOG entry for 2.0.0 — this was a substantial rewrite of the sync transport and was verified via multi-device simulation (push/pull in varying orders, overlapping items ranked on both "devices," deletions on one side merging with edits on the other) before being merged. Real two-account live verification against a hosted deployment remains the final check once a second user is available to run it, same as before.

**Security rules (must be updated in the Firebase console for 2.0.0 — a code change alone doesn't do this).** The pre-2.0.0 rule only needed to cover the single `rankers/shared` document; the append-only model needs the same two-UID allowlist extended to all three subcollections:

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
| Data | `view-data` | `exportData()`, `importData()`, `uploadToFirestore()`, `pullFromFirestore()`, `renderStats()`, `clearAllData()` |

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
| `filteredLibraryList()` | Returns the Library's currently-shown items for the active category — search text and field filters both applied; `renderLibrary()` and `bulkSetHidden()` both call this so the bulk actions always act on exactly what's on screen |
| `bulkSetHidden(hidden)` | Sets `hidden` on every item in `filteredLibraryList()` to the given value, saves, re-renders library + leaderboard + stats |
| `renderLibrary()` | Rebuilds selects + form, renders alphabetical item list |
| `openNewCatModal()` | Resets pending state and switches to the new-category view |
| `saveNewCat()` | Validates name + primary label, pushes to state, saves |
| `openSchemaEditor()` | Copies current schema into editing state, switches to schema view |
| `saveSchema()` | Writes editing state back to `state.schema`, saves |
| `confirmDeleteCat()` | Confirms with item count, deletes category + its items, saves |
| `editItem(id)` | Toggles inline edit expansion for an item row; collapses any other open row |
| `saveItem(id)` | Validates and writes edited field values back to state, saves |
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
| `mergeImport(incoming)` | Unconditional set-union merge — see "Merging rankings between devices" above |
| `unionItemsAndSchema(incoming, tombstoneIds)` | Adds items/cats/schema fields only present in `incoming` (skipping any id in `tombstoneIds`); last-write-wins on shared items' `fields` via `updatedAt` |
| `replayAllMatches()` | Resets every current item to `{elo:1000,wins:0,losses:0}` and replays the full `state.matchLog` (sorted by `(ts,seq)`) forward via `eloUpdatePure()` — the only source of truth for ratings, called at merge boundaries |
| `eloUpdatePure(w, l)` | Same math as `eloUpdate()` but operates on plain rating records instead of live item objects, for replay |
| `dedupeById(list)` / `dedupeByItemId(list)` | Dedupe helpers for unioning two `matchLog`s (by `.id`) or two `itemDeletes` lists (by `.itemId`) |
| `recordMatch(cat, wid, lid)` | Appends one permanent entry to `state.matchLog`, namespaced by `settings.deviceId` so two devices' match ids never collide |
| `deleteItem(id)` / `deleteItemsInCat(cat)` | Confirms, removes item(s), appends a tombstone per removed item to `state.itemDeletes` — see "Item deletions" above |
| `itemKey(cat, title)` | Deterministic hash of `(cat, title)` — the item id scheme since schema v4 |
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

A bulk toolbar above the item list ("Hide all shown (n)" / "Unhide all shown (n)") applies `bulkSetHidden(hidden)` to every item in `filteredLibraryList()` — the same search + field-filter-applied set the list itself renders, so the counts and the action always match what's on screen. This lets a user filter down to a subset (e.g. `Director: Wachowski`, or a search term) and hide or unhide the whole matching set in one click, without touching anything outside it.

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
| Deterministic item ids (`itemKey(cat, title)`) | Two devices agree on the same id for "the same" item with zero coordination — no identity-matching/remap step needed to merge | Random ids + title-based matching/remapping at merge time |
| Append-only matches/tombstones, unioned by id and always fully replayed (2.0.0) | No baseline/ancestry classification step to get wrong (the root cause of three real merge bugs in a row); push/pull become order-independent | Snapshot baseline + incremental match log (the pre-2.0.0 design — bounded replay cost, but repeatedly buggy in practice) |
| Merges never prompt — union is always unambiguous | Nothing is ever overwritten or compacted, so there's no case where the "right" resolution is unclear; removes an entire class of confirm-dialog misclicks (the exact failure mode of the old `diverged` prompt) | Prompt when a `diverged`/ambiguous case is detected (the pre-2.0.0 design) |
| Item deletions are tombstoned, field edits stay last-write-wins | Deletion had an actual documented failure mode (resurrection on merge); field edits don't — matching the fix to the real problem instead of over-engineering both | Track all edits as replayable events too |
| Firestore for cloud sync, loaded via CDN (not npm) | Free tier, real per-user security rules, zero server code to write/host, fits the zero-build-step single-file design | Custom backend, GitHub Gist + embedded token |
| Firestore stores one document per fact (item/match/tombstone), not a JSON blob (2.0.0) | Doc-ID-keyed writes are naturally idempotent, so push/pull don't need to happen in any particular order; also sidesteps Firestore's array-in-array restriction (Tier-mode history) without a JSON-string workaround | Single JSON-string blob document (the pre-2.0.0 design) |

---

## Known limitations & performance thresholds

### Rendering

`renderLibrary()` and `renderLB()` rebuild the entire list via `innerHTML` on every update. This is fine up to ~500 items per category. Beyond that:

| Items per category | Symptom | Fix |
|---|---|---|
| < 500 | No issues | — |
| 500–2,000 | Render flicker on slower devices | Paginate, or add virtual scrolling ([clusterize.js](https://clusterize.js.org/) drops in with minimal changes) |
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
- **Renamed items lose their match history on the *other* device.** Since id = `itemKey(cat, title)`, renaming an item locally changes its id; matches recorded against the old id become orphaned (silently dropped on replay) unless the rename has also propagated. Same failure mode as an item being deleted — not tombstoned, since a rename isn't a delete-then-recreate from the app's perspective and treating it as one would lose the item's ELO history unnecessarily.
- **Replay order across two devices' interleaved matches isn't reconstructed globally (accepted tradeoff, not a bug).** `mergeImport()` always fully replays the union of both matchLogs sorted by `(ts, seq)` — deterministic and never drops a match, but client clocks can disagree and `seq` is only comparable within one device's own log, so the exact ELO trajectory two people would have seen ranking in true real-time isn't guaranteed to match. See "Merging rankings between devices" above.
- **`settings.userName` is a deferred stub.** Added alongside `deviceId` (schema v4) but not wired into any UI — nothing reads or displays it yet. `deviceId` alone already guarantees match-id uniqueness, which was the actual technical requirement; `userName` was reserved for later human-readable attribution (e.g. on history entries) but deliberately deferred until that's actually needed. It is stripped from exports the same way `deviceId` is.

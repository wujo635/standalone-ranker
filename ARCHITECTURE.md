# Ranker — Architecture & Developer Guide

A single-file web app for ranking anything using pairwise ELO comparisons. Categories are fully user-defined with custom fields. No build step, no dependencies, no server required.

---

## Quick start

Open `ranker.html` in any modern browser. That's it.

---

## Current versions

| | Value |
|---|---|
| App version | `1.3.0` |
| Data schema version | `3` |
| localStorage key | `ranker-v1` |

Both constants live at the top of the `<script>` block and are the single source of truth. The Data tab displays them at runtime alongside the schema version of whatever is currently saved to localStorage.

---

## Version history

### App version (APP_VERSION)

Follows semantic versioning: `major.minor.patch`

- **major** — breaking change that requires a data migration
- **minor** — new feature, backward compatible
- **patch** — bug fix

| Version | Changes |
|---|---|
| 1.0.0 | Initial release as "Media Ranker"; hardcoded Year field, no schema |
| 1.1.0 | Schema system introduced (array per category); custom fields, required/optional |
| 1.2.0 | App renamed to "Ranker"; primary field label per category; versioning added |
| 1.3.0 | Inline item editing in library; Podium ranking mode; rank mode toggle |

### Data schema version (DATA_SCHEMA_VERSION)

Incremented only when the shape of `state` changes in a way that requires migration logic.

| Version | Shape |
|---|---|
| 1 | Items had a hardcoded `year` string field. No `schema` object. |
| 2 | `schema` introduced as a plain array of `{name, required}` per category. No `primary` label. |
| 3 | `schema[cat]` is `{ primary: string, fields: [{name, required}] }`. `_meta` block added to exports. |

### How to bump versions

When making changes:
1. Update `APP_VERSION` at the top of the script following semver
2. If `state`'s shape changed, increment `DATA_SCHEMA_VERSION` and add a migration case in `load()` and `importData()`
3. Add a row to both tables above

---

## File structure

Everything lives in one file: `ranker.html`

```
ranker.html
├── <style>       CSS custom properties + all component styles (~130 lines)
├── <body>        Six views: Library, New Category, Schema Editor, Rank, Leaderboard, Data
└── <script>      All app logic (~520 lines of vanilla JS)
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
        { name: 'Year', required: false },
        { name: 'Director', required: false }
      ]
    },
    "Songs": {
      primary: 'Title',
      fields: [
        { name: 'Artist', required: true },
        { name: 'Album', required: false },
        ...
      ]
    }
  },

  items: {
    "<uid>": {
      id:     string,   // uid() — timestamp + random suffix, e.g. "m3x1k2ab"
      cat:    string,   // must match a value in state.cats
      title:  string,   // value of the primary field
      fields: {         // values for all extra schema fields
        "Artist": "Radiohead",
        "Album": "OK Computer",
        ...
      },
      elo:    number,   // starts at 1000
      wins:   number,   // times chosen in a comparison
      losses: number    // times not chosen in a comparison
    }
  }
}
```

### Export format

Exported JSON wraps `state` with a `_meta` block:

```json
{
  "_meta": {
    "appVersion": "1.2.0",
    "dataSchemaVersion": 3,
    "exportedAt": "2026-07-05T12:00:00.000Z"
  },
  "cats": [...],
  "schema": {...},
  "items": {...}
}
```

### Persistence

`localStorage` key: `ranker-v1`

`save()` serializes the full `state` object on every write. `load()` deserializes it on page load, applying any needed migrations. The app also checks for the legacy `media-ranker-v1` key and migrates it automatically on first load.

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

### Podium

3–5 random items shown at once (pool size scales with list size — minimum 3 items required). You assign 🥇 🥈 🥉 to your top three. On confirm, ELO updates are applied for every implied pair:

- 1st beats 2nd, 3rd, and all unranked items in the pool
- 2nd beats 3rd and all unranked items
- 3rd beats all unranked items
- Unranked items are not compared against each other (no preference expressed)

With a full pool of 5 items, one podium round generates up to 9 ELO updates vs 1 for standard mode — significantly faster convergence on large lists.

The mode toggle (1 vs 1 / Podium) is persistent within a session but not saved to localStorage — it resets to Standard on page reload. To persist it, add `rankMode` to the `state` object.

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
| Rank | `view-rank` | `initRankView()`, `setRankMode()`, `loadPair()`, `vsCard()`, `vote()`, `loadPodium()`, `renderPodium()`, `submitPodium()` |
| Leaderboard | `view-leaderboard` | `renderLB()` |
| Data | `view-data` | `exportData()`, `importData()`, `renderStats()`, `clearAllData()` |

Tab switching is handled by `switchTab(id)`, which toggles `.active` on both nav buttons and view divs. New Category and Schema Editor are modal-style views with no nav tab — they're entered programmatically and return to Library on save or cancel.

---

## Key functions

| Function | What it does |
|---|---|
| `load()` | Reads localStorage, runs migrations, rebuilds selects, renders all views |
| `save()` | Serializes `state` to localStorage |
| `rebuildCatSelects()` | Syncs both `<select>` elements to `state.cats` |
| `schemaFor(cat)` | Returns `{ primary, fields }` for a category, with safe defaults |
| `primaryLabel(cat)` | Returns the primary field label string for a category |
| `extraFields(cat)` | Returns the extra fields array for a category |
| `renderAddForm()` | Dynamically renders the Add item form based on the active category's schema |
| `addItem()` | Validates inputs, creates item at ELO 1000, saves, re-renders library |
| `deleteItem(id)` | Confirms, removes item, saves, re-renders library + leaderboard |
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
| `loadPair()` | Picks 2 random items from the active rank category, renders VS cards |
| `vsCard(winner, loser)` | Returns HTML string for one side of a comparison card |
| `vote(wid, lid)` | Runs ELO update, saves, re-renders leaderboard, loads next pair |
| `loadPodium()` | Picks 3–5 random items for a podium round, resets placement state, renders |
| `renderPodium()` | Renders podium items with place assignment buttons; shows Confirm once 3 placed |
| `assignPlace(itemId, place)` | Assigns a podium position (1/2/3) to an item, displacing any previous occupant |
| `clearPodiumPlace(itemId)` | Removes an item's podium placement |
| `submitPodium()` | Derives all implied pairwise ELO updates from podium order, saves, loads next round |
| `eloUpdate(w, l)` | Pure ELO math, mutates winner/loser objects in place |
| `renderLB()` | Renders ELO-sorted leaderboard with category pills and medals |
| `itemMeta(item)` | Returns formatted extra field values for display in cards/rows |
| `renderStats()` | Renders version info + item/vote counts in the Data tab |
| `exportData()` | Wraps state with `_meta`, serializes to JSON, triggers download |
| `importData(e)` | Reads JSON file, runs migrations, merges into state, re-renders |
| `clearAllData()` | Confirms, resets state to defaults, clears localStorage |
| `uid()` | Generates a short collision-resistant ID |
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

### Add filtering or search to the library

Add a search `<input>` above the list and filter `libItems()` before rendering:

```js
const q = document.getElementById('search').value.toLowerCase();
const list = libItems().filter(i => i.title.toLowerCase().includes(q));
```

### Add notes/tags to items

Extend the item object with `notes: string` and `tags: string[]`. Add inputs in `renderAddForm()`. Filter by tag in the library view. Tags could also drive a new "browse by tag" view.

### Add a "not yet seen/heard/read" toggle

Add a `seen: boolean` field to items. Show unseen items in a separate Watchlist tab. Only include `seen: true` items in ranking and leaderboard.

### Smart pair selection

Replace random pairing in `loadPair()` with ELO-proximity selection — pairs with similar scores are more informative:

```js
function smartPair(list) {
  const sorted = [...list].sort((a, b) => a.elo - b.elo);
  const idx = Math.floor(Math.random() * (sorted.length - 1));
  return [sorted[idx], sorted[idx + 1]];
}
```

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

For multi-device sync, you'd need a backend (see above) or use the export/import flow manually.

---

## Design decisions & tradeoffs

| Decision | Why | Alternative |
|---|---|---|
| Single HTML file | Zero setup, trivially shareable | Multi-file with a bundler |
| localStorage | No server needed | IndexedDB (larger data), backend |
| ELO scoring | Well-understood, self-balancing | TrueSkill, simple win-count |
| Random pair selection | Simple, covers the space over time | Smart pair selection (pick closest ELO) |
| Vanilla JS | No build step, easy to read and edit | React/Vue/Svelte |
| JSON export | Human-readable, re-importable, version-stamped | CSV, binary |
| Schema per category | Flexible, user-defined fields | Hardcoded fields per type |
| Multiple ranking modes | Different speeds suit different use cases | Single mode only |
| Inline editing | Edit without leaving the library view | Separate edit screen |

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

### No undo

Deletions are permanent (there's a confirm prompt, but no undo stack). Fix: soft-delete with a `deleted: true` flag and a "Recently deleted" view.

### Single-user

Data is local to one browser profile. No sync, no sharing. Fix: add a backend (see "Switch from localStorage to a backend" above).

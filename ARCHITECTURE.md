# Ranker — Architecture & Developer Guide

A single-file web app for ranking anything using pairwise ELO comparisons. Categories are fully user-defined with custom fields. No build step, no dependencies, no server required.

---

## Quick start

Open `index.html` in any modern browser. That's it.

---

## Current versions

| | Value |
|---|---|
| App version | `1.13.1` |
| Data schema version | `3` |
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
└── <script>      All app logic (~750 lines of vanilla JS)
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
      losses: number,   // times not chosen in a comparison
      hidden: boolean   // if true, excluded from ranking selection and the leaderboard; still visible/editable in Library
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
      updates: [...]      // for podium/tier: [{wid, lid, wChange, lChange}, ...] for undo reversal
    }
  ]
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

### Import conflict resolution

JSON imports are resolved per category:

| Situation | Behaviour |
|---|---|
| Category in file does not exist locally | Imported freely, no prompt |
| Category in file already exists locally | Confirm dialog: **OK** replaces local category entirely; **Cancel** skips it |

Replacing a category removes all local items for that category before writing the imported ones — no duplicates possible. The toast on completion reports how many items were imported and which categories were skipped.

This means importing is safe to use as an update mechanism: import a file with corrected data, choose Replace for the affected category, and the local copy is cleanly overwritten.

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
| Data | `view-data` | `exportData()`, `importData()`, `renderStats()`, `clearAllData()` |

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
| `loadTier()` | Prompts for session size, assembles pool prioritising zero-comparison items, resets placements, renders |
| `renderTier()` | Renders tier lanes (S/A/B/C/D) with placed chips and untiered item list with tier buttons |
| `assignTier(itemId, tier)` | Places an item into a tier lane |
| `removeTierPlacement(itemId)` | Returns an item from a tier lane back to untiered |
| `submitTier()` | Derives all implied pairwise ELO updates from tier order (items in same tier not compared), saves, loads next session |
| `recordRanking(entry)` | Appends a ranking to `state.history` with timestamp; keeps only last 50 entries (called after each vote/podium/tier session) |
| `undoRanking(idx)` | Reverses ELO, wins, losses for all items involved in a ranking; removes entry from history; refreshes leaderboard and history views |
| `renderHistory()` | Renders the last 50 rankings in reverse chronological order with undo buttons for each |
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
| `itemsWithoutHidden()` | Returns a copy of `state.items` with the `hidden` key stripped from every item; used by `exportData()` so hidden status (a personal, per-browser preference) never travels in an exported file |
| `exportData()` | Wraps state with `_meta`, serializes to JSON (items via `itemsWithoutHidden()`), triggers download |
| `exportCategoryCSV()` | Exports the currently selected library category as a preload-compatible CSV with schema directives; no ELO or ranking data |
| `csvCell(val)` | Escapes a value for CSV output — wraps in quotes if it contains commas, quotes, or newlines |
| `importData(e)` | Reads JSON file, runs `migrateData()`, then prompts per category to replace or skip when conflicts exist; forces `hidden: false` on every incoming item so a personal hide preference from another user's export can't apply locally |
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
- `renderLibrary()` calls `getFilteredItems(rankCat(), list, filterState)` before displaying items
- `loadPair()`, `loadPodium()`, `loadTier()` all apply `getFilteredItems()` to their item pools
- `renderLB()` applies filters to the leaderboard display

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

For multi-device sync, you'd need a backend (see above) or use the export/import flow manually.

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

### Single-user

Data is local to one browser profile. No sync, no sharing. Fix: add a backend (see "Switch from localStorage to a backend" above).

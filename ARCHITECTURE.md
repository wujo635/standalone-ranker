# Media Ranker — Architecture & Developer Guide

A single-file web app for tracking and ranking personal media collections using pairwise ELO comparisons. No build step, no dependencies, no server required.

---

## Quick start

Open `media-ranker.html` in any modern browser. That's it.

---

## File structure

Everything lives in one file: `media-ranker.html`

```
media-ranker.html
├── <style>          CSS custom properties + all component styles
├── <body>           Four tab views (Library, Rank, Leaderboard, Data)
└── <script>         All app logic (~200 lines of vanilla JS)
```

---

## Data model

All state is held in a single `state` object in memory and mirrored to `localStorage`.

```js
state = {
  cats: ['Movies', 'Songs', 'Actors', ...],  // ordered list of category names
  items: {
    "<uid>": {
      id:     string,   // uid() — timestamp + random suffix, e.g. "m3x1k2ab"
      cat:    string,   // must match a value in state.cats
      title:  string,
      year:   string,   // optional, stored as string
      elo:    number,   // starts at 1000
      wins:   number,   // times picked in a comparison
      losses: number    // times not picked in a comparison
    }
  }
}
```

### Persistence

`localStorage` key: `media-ranker-v1`

The whole `state` object is serialized to JSON on every write (`save()`), and deserialized on page load (`load()`). The export/import feature uses the same JSON shape, so exported files are directly re-importable.

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

All items start at ELO 1000. After enough comparisons, scores naturally spread — a well-ranked list typically has a range of ~200–400 points between top and bottom.

The leaderboard score bar is normalized: the top item always fills 100%, the bottom always sits at 0%, everything else scales between them.

---

## Tab views

| Tab | ID | Key function |
|---|---|---|
| Library | `view-library` | `renderLibrary()` |
| Rank | `view-rank` | `loadPair()`, `vote()` |
| Leaderboard | `view-leaderboard` | `renderLB()` |
| Data | `view-data` | `exportData()`, `importData()`, `renderStats()` |

Tab switching is handled by `switchTab(id)`, which toggles `.active` on both the nav buttons and the view divs.

---

## Key functions

| Function | What it does |
|---|---|
| `load()` | Reads localStorage, rebuilds selects, renders all views |
| `save()` | Serializes `state` to localStorage |
| `addItem()` | Creates a new item at ELO 1000, saves, re-renders library |
| `deleteItem(id)` | Removes item by id, saves, re-renders library + leaderboard |
| `loadPair()` | Picks 2 random items from the active rank category, renders VS cards |
| `vote(wid, lid)` | Runs ELO update, saves, re-renders leaderboard, loads next pair |
| `renderLibrary()` | Renders alphabetical item list for current library category |
| `renderLB()` | Renders ELO-sorted leaderboard for `lbCat`, with category pills |
| `rebuildCatSelects()` | Syncs both `<select>` elements to `state.cats` |
| `addCustomCat()` | Prompts for name, pushes to `state.cats`, rebuilds selects |
| `exportData()` | Serializes `state` → Blob → download |
| `importData(e)` | Reads JSON file, merges items + cats into state, re-renders |
| `eloUpdate(w, l)` | Pure ELO math, mutates winner/loser objects in place |
| `uid()` | Generates a short collision-resistant ID |
| `esc(s)` | HTML-escapes strings before injecting into innerHTML |

---

## How to expand

### Add a new field to items

1. Add the field in `addItem()` when constructing the item object
2. Add an input in the Library card HTML
3. Display it wherever relevant (item rows, VS cards)
4. Existing saved items won't have the field — use `item.field ?? defaultValue` to handle gracefully

### Add a new category type

Categories are just strings. Users can already add custom ones via "+ New category". No code change needed unless you want category-specific behavior (e.g. different fields for Songs vs Movies).

### Add filtering or search to the library

Add a search `<input>` above the list and filter `libItems()` before rendering:

```js
const q = document.getElementById('search').value.toLowerCase();
const list = libItems().filter(i => i.title.toLowerCase().includes(q));
```

### Add notes/tags to items

Extend the item schema with `notes: string` and `tags: string[]`. Render a tag input using comma-split on a text field. Filter by tag in the library view.

### Add an "unseen" vs "seen" toggle

Add a `seen: boolean` field. Show unseen items in a separate "Watchlist" tab. Only include `seen: true` items in ranking and leaderboard.

### Switch from localStorage to a backend

Replace `save()` and `load()` with `fetch()` calls to a REST API or serverless function. The state shape is already JSON-serializable — no transformation needed. Suggested stack: a simple Node/Express server or Cloudflare Worker with a KV store or SQLite.

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
| JSON export | Human-readable, re-importable | CSV, binary |

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

For a personal tracker this is unlikely to be a real concern — even a very dedicated user would struggle to hit 500 items in a single category.

### localStorage cap

Browsers limit localStorage to ~5MB. At ~500 bytes per item that's roughly 10,000 items before issues arise. The limit comes sooner if you add notes, tags, or other large fields. Fix: switch to IndexedDB (same browser, async API, much higher limits).

### Random pair selection

The current algorithm picks two random items independently. This has two side effects: the same pair can be shown twice in a row, and it selects uninformative matchups (e.g. a 1400-ELO item vs a 600-ELO item, whose outcome is already predictable). With small lists this is noticeable; with large lists it means thousands of votes are needed before rankings stabilize.

Better approach: prioritize pairs with similar ELO scores — those comparisons carry the most information. Implementation sketch:

```js
function smartPair(list) {
  const sorted = [...list].sort((a, b) => a.elo - b.elo);
  const idx = Math.floor(Math.random() * (sorted.length - 1));
  return [sorted[idx], sorted[idx + 1]]; // adjacent ELO = most informative
}
```

### No undo

Deletions are permanent (there's a confirm prompt, but no undo stack). Fix: soft-delete with a `deleted: true` flag and a "Recently deleted" view.

### Single-user

Data is local to one browser profile. No sync, no sharing. Fix: add a backend (see "Switch from localStorage to a backend" above).

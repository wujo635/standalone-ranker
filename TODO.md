# To-do / Future Work

Tracks ideas and known gaps noted in `ARCHITECTURE.md` but not yet scheduled. Not a changelog — once something here ships, move its entry to `CHANGELOG.md` and delete it from this list.

## Sync / data model

- **Undo for item/category deletions.** Deletions are permanent today (confirm prompt only, no undo stack). Would need a soft-delete (`deleted: true`) plus a "Recently deleted" view. [ARCHITECTURE.md "Item deletions"](ARCHITECTURE.md)
- **(Explore — not required) Sync `filterable`/`required` changes on existing fields.** Today `adoptIncomingFields()` only adopts brand-new fields and newly-on `identity` flags; toggling an already-shared field's filterable (🔍/∅) or required setting stays on the device that did it, deliberately ("low stakes if they diverge"). Built-in categories (Movies, Songs) start from the default schema everywhere, so even a device adopting a fresh baseline never picks the change up. Side effect: the root doc's `schema` flip-flops with whoever uploaded last. If it should sync: per-field last-write-wins, which needs a timestamp per field setting (e.g. `filterableAt`) since the root doc's `updatedAt` covers the whole schema; consider whether filterable is better as a per-device preference, like `hidden`. Note the toggle only affects the filter panel — Library search matches every field regardless. [ARCHITECTURE.md "Item identity fields"](ARCHITECTURE.md)
- **Expand cloud sync beyond two users.** Deliberately out of scope for now. Short-term: swap the hardcoded two-UID Firestore rule for an allowlist collection. Long-term (self-serve, multiple groups): a from-scratch redesign of the sync layer, not an incremental change. [ARCHITECTURE.md "Extending the app"](ARCHITECTURE.md)

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

# Changelog

Full release history for Ranker. See [ARCHITECTURE.md](ARCHITECTURE.md) for the current version numbers, the versioning rules, and how to bump them.

## App version (APP_VERSION)

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
| 1.4.0 | `migrateData()` function added; migration scaffolding wired into `load()` and `importData()`; version history comments added to script |
| 1.5.0 | CSV preload import with schema parsing and per-category conflict resolution (merge or replace) |
| 1.5.1 | Bug fix: `migrateData()` was unconditionally running v1 migration on every load, corrupting `item.fields`; fixed to check for existing fields first; `_meta` now stamped after migration so future loads skip correctly |
| 1.5.2 | Field labels shown in library and leaderboard when 2+ fields populated; ELO hidden during ranking to prevent anchoring bias; fields rendered as stacked lines in VS and Podium cards; all non-ASCII bytes in script replaced with unicode escapes to prevent parse errors |
| 1.5.3 | JSON import revised to prompt per category when conflicts exist — replace local data or skip; prevents duplicate items when importing overlapping datasets |
| 1.5.4 | Export current category as CSV (library only, no rankings); output is compatible with CSV preload import format so recipients can start fresh |
| 1.5.5 | CSV import into existing category now offers three options: bulk add (update fields on title matches, add new items, preserve all ELO/rankings), replace (wipe and start fresh), or cancel |
| 1.6.0 | Tier ranking mode: S/A/B/C/D tiers, configurable session size, prioritises unranked items, generates up to n*(n-1)/2 ELO updates per session; skip button hidden in tier mode |
| 1.7.0 | Smart pair selection: optional toggle in Rank tab, uses ELO-proximity instead of random pairing for all three ranking modes (VS, Podium, Tier); helps rankings converge faster with large pools |
| 1.8.0 | Library search/filter: real-time search across titles and all field values, case-insensitive; useful for large categories (50+ items) |
| 1.9.0 | History tab: view the last 50 rankings across all modes with timestamps and categories; undo button to reverse any ranking and restore ELO scores |
| 1.10.0 | Field-based filtering: filter items by extra fields with smart type inference (numeric ranges with >=, <=, = operators; categorical with multi-select checkboxes); applies to Library view and all ranking modes; collapsible filter section to save screen space |
| 1.11.0 | Filter fields by "Has value" (non-blank) regardless of type; fixed latent bug where numeric fields with a blank value were always excluded from filtered views even with no active filter |
| 1.11.1 | Bug fix: Library item rows overflowed horizontally when titles or field values were long, because fields were joined onto one `white-space: nowrap` line; fields now stack one per line and the row/title wrap and shrink instead of forcing width |
| 1.12.0 | Field names bolded (`itemMeta()`) when shown with labels, in Library rows, Leaderboard, and Rank cards (VS/Podium) |
| 1.12.1 | Bug fix: Podium and Tier cards had the same overflow risk Library had in 1.11.1 (`.podium-info`/`.tier-item-info` missing `min-width: 0` and word-break) — fixed the same way. Internal refactor (no behavior change): `renderLibrary()` now calls `itemMeta()` instead of reimplementing it; added `itemsForCat()` and `deleteItemsInCat()` helpers to remove duplicated category-filtering and category-deletion logic; added `applyEloUpdate()` to remove duplicated before/after ELO delta tracking in `vote()`, `submitPodium()`, `submitTier()`; merged the identical podium/tier branches in `undoRanking()`; removed unused `TIER_COLOR` |
| 1.12.2 | Internal refactor (no behavior change): `renderFilterUI()` no longer builds one HTML string and mutates it with `.replace(new RegExp(...))` to produce the lib/rank id variants — it now builds the field cards once via `buildFilterFieldCards()` and wraps them per-container via `buildFilterPanel(cat, filterId, ...)` with the id passed in directly. Removes a latent bug: the old regex replace ran globally against the *entire rendered HTML*, so a field value that happened to contain the substring `filter-fields-<category>` would have been silently corrupted |
| 1.13.0 | Items can be hidden from the Library (◎/◉ toggle button, `toggleHidden(id)`); hidden items stay visible (dimmed, tagged) in the Library for un-hiding but are excluded from `itemsForCat()`, so they never appear in any rank mode or the Leaderboard |
| 1.13.1 | `hidden` is now treated as a personal, per-browser preference: `exportData()` strips it from every item before serializing (`itemsWithoutHidden()`), and `importData()` forces `hidden: false` on every incoming item — so passing JSON exports between users no longer imposes one person's hidden set on another |
| 1.13.2 | Bug fix: `undoRanking()` silently skipped ELO reversal for any pair in a history entry where an item had since been deleted, while still removing the entry and reporting "Undo complete" — for podium/tier entries this left the *other* items in the entry partially reverted with no way to detect it. Added `canUndo(entry)`/`entryItemIds(entry)` to check upfront that every item a reversal needs still exists; `undoRanking()` now refuses (toast, no state change) instead of partially applying, and `renderHistory()` shows a disabled "Undo unavailable" button for affected entries |
| 1.14.0 | Library: "Hide all shown" / "Unhide all shown" bulk toolbar above the item list, scoped to the currently filtered + searched set (`filteredLibraryList()`/`bulkSetHidden()`) — lets a user filter down to a subset and hide or unhide the whole thing in one click |
| 1.15.0 | Standard (1v1) rank mode: keyboard voting via `ArrowLeft`/`1` and `ArrowRight`/`2` (`handleRankVoteKey()`), with the shortcut shown on each card; running "n voted this session" counter next to "Which do you prefer?" that resets when the rank category changes |
| 1.16.0 | Merging rankings between two devices: importing a JSON export now reconciles rankings via `mergeImport()` instead of a per-category Replace/Skip prompt — comparisons made independently on both sides since the last sync are combined by replaying `matchLog` forward from a shared `syncBase` snapshot (see [ARCHITECTURE.md](ARCHITECTURE.md#merging-rankings-between-devices)); a confirm prompt only appears when the two files' history doesn't line up. Item ids are now deterministic (`itemKey(cat, title)`) so two devices agree on the same id for the same item with no coordination. New Data tab "Sync status" card shows baseline revision, last synced time, and unsynced comparison count. |
| 1.17.0 | Cloud sync: optional Firestore-backed Upload/Pull as a second transport alongside file export/import, going through the same `buildExportPayload()`/`migrateData()`/`mergeImport()` pipeline (see [ARCHITECTURE.md](ARCHITECTURE.md#cloud-sync-firestore)) — Google sign-in gates Upload/Pull, security rules restrict the shared document to two allowlisted accounts. First external dependency in the app (Firebase compat SDK via CDN `<script>` tags, no npm/build step); defensively wrapped so a blocked/failed Firebase load degrades to a disabled cloud-sync card instead of breaking the app. |
| 1.17.1 | Bug fix: `uploadToFirestore()` was a blind overwrite — if one device pushed without first pulling another device's already-uploaded change, the push silently destroyed it with no merge and no warning. Upload now reads the current cloud document and runs it through `mergeImport()` (the same pipeline Pull uses) before pushing, so a push can no longer lose data. `mergeImport()` now returns `true`/`false` so callers can tell whether the merge actually completed or the user declined a diverged-history prompt. |

## Data schema version (DATA_SCHEMA_VERSION)

Incremented only when the shape of `state` changes in a way that requires migration logic.

| Version | Shape |
|---|---|
| 1 | Items had a hardcoded `year` string field. No `schema` object. |
| 2 | `schema` introduced as a plain array of `{name, required}` per category. No `primary` label. |
| 3 | `schema[cat]` is `{ primary: string, fields: [{name, required}] }`. `_meta` block added to exports. |
| 4 | Item ids switched from random `uid()` to deterministic `itemKey(cat, title)`; items gained `updatedAt`. Added `state.matchLog` (append-only pairwise results since the last sync) and `state.syncBase` (`{id, parentId, rev, ts, ratings}` snapshot baseline) to support merging rankings from two devices. History entries gained `matchIds` linking them to the log entries they created. |

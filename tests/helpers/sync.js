// Two-device sync helpers shared by multi-device tests. Each models one real sync path
// between two loadApp() pages, going through the same functions the app uses.

// What pullFromFirestore() hands mergeImport() after `src` uploads: item docs without
// ratings, matches, and tombstones round-tripped through the same doc mapping the
// upload/pull code uses (tombstoneDoc() on the sender, tombstoneFromDoc() on the receiver).
function pull(dst, src) {
  const s = src.get('state');
  const items = {};
  Object.values(s.items).forEach(i => { items[i.id] = { id: i.id, cat: i.cat, title: i.title, fields: i.fields, updatedAt: i.updatedAt }; });
  const docs = src.get('state.itemDeletes.map(tombstoneDoc)');
  const itemDeletes = dst.get(`${JSON.stringify(docs)}.map(tombstoneFromDoc)`);
  const incoming = { items, cats: s.cats, schema: s.schema, matchLog: s.matchLog,
    itemDeletes, itemUndeletes: s.itemUndeletes, catDeletes: s.catDeletes, catUndeletes: s.catUndeletes };
  dst.run(`mergeImport(${JSON.stringify(incoming)}, { cloudOrigin: true })`);
}

// File path: `src` exports, `dst` imports (importData() -> mergeImport(migrateData(json))).
function importFrom(dst, src) {
  dst.run(`mergeImport(migrateData(${JSON.stringify(src.get('buildExportPayload()'))}))`);
}

module.exports = { pull, importFrom };

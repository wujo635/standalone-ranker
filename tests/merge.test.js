// mergeImport(): the two-device sync core. Most cases here pin a real bug from
// CHANGELOG.md (noted per test) so it can't quietly come back.
//
// Two entry paths are modelled exactly as the app calls them:
//   - file import:  importData() -> mergeImport(migrateData(json))
//   - cloud pull:   pullFromFirestore() -> mergeImport(incoming, { cloudOrigin: true })
//                   (no migrateData; item docs normally carry no elo/wins/losses)
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let app;
beforeEach(() => { app = loadApp(); });
afterEach(() => { app.close(); });

// --- helpers -------------------------------------------------------------------

const key = (cat, title, suffix) => app.call('itemKey', cat, title, suffix);

function item(cat, title, over = {}) {
  const { suffix, ...rest } = over;
  const id = key(cat, title, suffix);
  return { id, cat, title, fields: {}, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1, ...rest };
}
const byId = list => Object.fromEntries(list.map(i => [i.id, i]));

// Local device state: freshState() (for its real settings/deviceId) with overrides.
function setLocal(over = {}) {
  const s = app.get('freshState()');
  app.setState({ ...s, ...over, settings: { ...s.settings, ...(over.settings || {}) } });
}

// A current-version export from another device.
function exportPayload(over = {}) {
  return {
    _meta: { appVersion: '2.16.1', dataSchemaVersion: 6, exportedAt: '2026-09-01T00:00:00.000Z' },
    cats: ['Movies'], schema: { Movies: { primary: 'Title', fields: [{ name: 'Year', required: false }] } },
    items: {}, matchLog: [], history: [],
    itemDeletes: [], itemUndeletes: [], catDeletes: [], catUndeletes: [],
    settings: { smartPairMode: false, matchSeq: 0 },
    ...over,
  };
}

const importFile = payload => app.run(`mergeImport(migrateData(${JSON.stringify(payload)}))`);
const pullCloud = incoming => app.run(`mergeImport(${JSON.stringify(incoming)}, { cloudOrigin: true })`);
const state = () => app.get('state');
const match = (id, w, l, ts = 10, seq = 1) => ({ id, cat: w.cat, wid: w.id, lid: l.id, ts, seq });
const rating = i => [i.elo, i.wins, i.losses];

// Same formula as eloUpdate() (K = 32, rounded), written out independently as the spec.
function eloAfter(w, l) {
  const E = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
  return [Math.round(w.elo + 32 * (1 - E)), Math.round(l.elo + 32 * (0 - 1 + E))];
}

// --- items & fields ------------------------------------------------------------

describe('items and fields', () => {
  test('unions new items and categories; an existing item never adopts an incoming rating', () => {
    const heatLocal = item('Movies', 'Heat', { fields: { Year: '1995' }, elo: 1100, wins: 5, updatedAt: 100 });
    setLocal({ items: byId([heatLocal]) });
    const heatRemote = item('Movies', 'Heat', { fields: { Year: '1995' }, elo: 900, wins: 1, updatedAt: 100 });
    const ronin = item('Movies', 'Ronin', { elo: 1050, wins: 2, losses: 1 });
    const book = item('Books', 'Dune', { elo: 1010, wins: 1 });
    importFile(exportPayload({
      cats: ['Movies', 'Books'],
      schema: { Movies: { primary: 'Title', fields: [{ name: 'Year', required: false }] }, Books: { primary: 'Title', fields: [{ name: 'Author', required: false }] } },
      items: byId([heatRemote, ronin, book]),
    }));
    const s = state();
    assert.deepEqual(rating(s.items[heatLocal.id]), [1100, 5, 0], 'local rating kept');
    assert.deepEqual(rating(s.items[ronin.id]), [1050, 2, 1], 'new item arrives with its rating');
    assert.ok(s.cats.includes('Books'));
    assert.deepEqual(s.schema.Books, { primary: 'Title', fields: [{ name: 'Author', required: false }] });
    assert.ok(s.items[book.id]);
  });

  test('field edits are last-write-wins by updatedAt', () => {
    const heat = item('Movies', 'Heat', { fields: { Year: '1995' }, updatedAt: 100 });
    const ronin = item('Movies', 'Ronin', { fields: { Year: '1998' }, updatedAt: 100 });
    setLocal({ items: byId([heat, ronin]) });
    importFile(exportPayload({
      items: byId([
        { ...heat, fields: { Year: '1996' }, updatedAt: 200 },  // newer: wins
        { ...ronin, fields: { Year: '1999' }, updatedAt: 50 },  // older: ignored
      ]),
    }));
    const s = state();
    assert.deepEqual(s.items[heat.id].fields, { Year: '1996' });
    assert.equal(s.items[heat.id].updatedAt, 200);
    assert.deepEqual(s.items[ronin.id].fields, { Year: '1998' });
  });

  test('a newer edit brings its title along, so a case-only title change syncs (2.17.0)', () => {
    // "heat" and "Heat" share an id (itemKey() lowercases), so this is an edit, not a
    // rename. Before 2.17.0 only fields were taken and the old casing stuck forever.
    const heat = item('Movies', 'heat', { updatedAt: 100 });
    setLocal({ items: byId([heat]) });
    importFile(exportPayload({ items: byId([{ ...heat, title: 'Heat', updatedAt: 200 }]) }));
    assert.equal(state().items[heat.id].title, 'Heat');
  });

  test('hidden stays per-device: kept on existing items, forced false on new ones', () => {
    const heat = item('Movies', 'Heat', { hidden: true, updatedAt: 100 });
    setLocal({ items: byId([heat]) });
    const ronin = item('Movies', 'Ronin', { hidden: true });
    importFile(exportPayload({ items: byId([{ ...heat, hidden: false, fields: { Year: '1995' }, updatedAt: 200 }, ronin]) }));
    const s = state();
    assert.equal(s.items[heat.id].hidden, true);
    assert.equal(s.items[ronin.id].hidden, false);
  });
});

// --- matches -------------------------------------------------------------------

describe('matches', () => {
  test('importing a full export into an empty device neither double-counts nor drops matches (2.0.2 / 2.5.4)', () => {
    // Source device: one vote, Heat beat Ronin, already reflected in both ratings.
    const heat = item('Movies', 'Heat', { elo: 1016, wins: 1 });
    const ronin = item('Movies', 'Ronin', { elo: 984, losses: 1 });
    const m1 = match('dSrc-1', heat, ronin);
    setLocal({ items: {} });
    importFile(exportPayload({ items: byId([heat, ronin]), matchLog: [m1] }));
    const s = state();
    assert.deepEqual(rating(s.items[heat.id]), [1016, 1, 0], '2.0.2: not re-applied on top of the imported rating');
    assert.deepEqual(rating(s.items[ronin.id]), [984, 0, 1]);
    assert.deepEqual(s.matchLog.map(m => m.id), ['dSrc-1'], '2.5.4: still recorded, so this device can upload it later');
  });

  test('new matches apply on top of existing ratings, never a reset-and-replay (2.0.1)', () => {
    // Local ratings already include history that is no longer in matchLog (pre-v6
    // compaction). A from-scratch replay would wipe it; this must only add the delta.
    const heat = item('Movies', 'Heat', { elo: 1240, wins: 20, losses: 2 });
    const ronin = item('Movies', 'Ronin', { elo: 900, wins: 2, losses: 20 });
    setLocal({ items: byId([heat, ronin]), matchLog: [] });
    const m2 = match('dOther-1', ronin, heat);
    importFile(exportPayload({ items: byId([item('Movies', 'Heat'), item('Movies', 'Ronin')]), matchLog: [m2] }));
    const s = state();
    const [roninElo, heatElo] = eloAfter(ronin, heat);
    assert.deepEqual(rating(s.items[heat.id]), [heatElo, 20, 3]);
    assert.deepEqual(rating(s.items[ronin.id]), [roninElo, 3, 20]);
  });

  test('merging the same payload twice is a no-op the second time', () => {
    const heat = item('Movies', 'Heat');
    const ronin = item('Movies', 'Ronin');
    setLocal({ items: byId([heat, ronin]) });
    const payload = exportPayload({ items: byId([heat, ronin]), matchLog: [match('dOther-1', heat, ronin)] });
    importFile(payload);
    const once = state();
    importFile(payload);
    const twice = state();
    assert.deepEqual(twice.items, once.items);
    assert.equal(twice.matchLog.length, 1);
    assert.deepEqual(rating(once.items[heat.id]), [1016, 1, 0]);
  });

  test('matches apply in (ts, seq) order regardless of arrival order', () => {
    const a = item('Movies', 'A'), b = item('Movies', 'B'), c = item('Movies', 'C');
    const m1 = match('dX-1', a, b, 10, 1), m2 = match('dX-2', b, c, 10, 2), m3 = match('dX-3', c, a, 20, 3);
    setLocal({ items: byId([a, b, c]) });
    importFile(exportPayload({ items: {}, matchLog: [m1, m2, m3] }));
    const inOrder = state().items;
    setLocal({ items: byId([a, b, c]) });
    importFile(exportPayload({ items: {}, matchLog: [m3, m1, m2] }));
    assert.deepEqual(state().items, inOrder);
  });

  // Mixed pairing: a file brings a brand-new item (Ronin, freshly seeded — its rating
  // already includes the match) that beat an item this device already had (Heat, whose
  // rating doesn't). Only Heat's side may be applied.
  const mixedPairing = () => {
    const heat = item('Movies', 'Heat');
    const ronin = item('Movies', 'Ronin', { elo: 1016, wins: 1 });
    const m3 = match('dOther-1', ronin, heat);
    return { heat, ronin, m3, payload: exportPayload({ items: byId([heat, ronin]), matchLog: [m3] }) };
  };

  test('a match between a brand-new item and an existing one updates only the existing side (2.16.2)', () => {
    const { heat, ronin, payload } = mixedPairing();
    setLocal({ items: byId([heat]) });
    importFile(payload);
    const s = state();
    const [, heatElo] = eloAfter(ronin, heat);
    assert.deepEqual(rating(s.items[heat.id]), [heatElo, 0, 1], 'existing item gets its loss now');
    assert.deepEqual(rating(s.items[ronin.id]), [1016, 1, 0], 'new item unchanged: its rating already had this win');
    assert.deepEqual(s.matchLog.map(m => m.id), ['dOther-1'], 'recorded, so it is never applied again');
  });

  test('importing the same file again does not double-count the new item (2.16.2 regression)', () => {
    // Before 2.16.2 the match was held back on the first import, then applied to BOTH
    // sides on the second — giving Ronin a second win for one match.
    const { heat, ronin, payload } = mixedPairing();
    setLocal({ items: byId([heat]) });
    importFile(payload);
    const once = state();
    importFile(payload);
    const twice = state();
    assert.deepEqual(twice.items, once.items);
    assert.deepEqual(rating(twice.items[ronin.id]), [1016, 1, 0]);
    assert.equal(twice.matchLog.length, 1);
  });

  test('a later cloud pull of the same match does not double-count it (2.16.2 regression)', () => {
    const { heat, ronin, m3, payload } = mixedPairing();
    setLocal({ items: byId([heat]) });
    importFile(payload);
    const afterImport = state();
    const doc = i => ({ id: i.id, cat: i.cat, title: i.title, fields: i.fields, updatedAt: i.updatedAt });
    pullCloud({ items: byId([doc(heat), doc(ronin)]), cats: ['Movies'], schema: {}, matchLog: [m3], itemDeletes: [], itemUndeletes: [], catDeletes: [], catUndeletes: [] });
    assert.deepEqual(state().items, afterImport.items);
  });

  test('one-sided updates are applied in (ts, seq) order alongside ordinary matches', () => {
    const heat = item('Movies', 'Heat'), batman = item('Movies', 'Batman');
    setLocal({ items: byId([heat, batman]) });
    const ronin = item('Movies', 'Ronin', { elo: 1016, wins: 1 });
    const m1 = match('dOther-1', heat, batman, 10, 1);  // both existing: full update
    const m2 = match('dOther-2', ronin, heat, 20, 2);   // mixed: Heat's side only
    importFile(exportPayload({ items: byId([ronin]), matchLog: [m2, m1] }));
    const s = state();
    const [heatAfterM1, batmanAfterM1] = eloAfter(heat, batman);
    const [, heatAfterM2] = eloAfter(ronin, { elo: heatAfterM1 });
    assert.deepEqual(rating(s.items[batman.id]), [batmanAfterM1, 0, 1]);
    assert.deepEqual(rating(s.items[heat.id]), [heatAfterM2, 1, 1]);
    assert.deepEqual(rating(s.items[ronin.id]), [1016, 1, 0]);
  });

  test('matches touching an item this device does not have are recorded but skipped', () => {
    const heat = item('Movies', 'Heat');
    setLocal({ items: byId([heat]) });
    const ghost = { id: 'ighost', cat: 'Movies' };
    pullCloud({ items: {}, cats: [], schema: {}, matchLog: [match('dOther-1', heat, ghost)], itemDeletes: [], itemUndeletes: [], catDeletes: [], catUndeletes: [] });
    const s = state();
    assert.deepEqual(rating(s.items[heat.id]), [1000, 0, 0], 'no half-applied rating change');
    assert.deepEqual(s.matchLog.map(m => m.id), ['dOther-1'], 'kept, so it can still be uploaded');
  });
});

// --- cloud pulls ---------------------------------------------------------------

describe('cloud pulls (cloudOrigin)', () => {
  const cloud = (over = {}) => ({ items: {}, cats: ['Movies'], schema: {}, matchLog: [], itemDeletes: [], itemUndeletes: [], catDeletes: [], catUndeletes: [], ...over });
  // Firestore item docs carry no ratings.
  const doc = i => ({ id: i.id, cat: i.cat, title: i.title, fields: i.fields, updatedAt: i.updatedAt });

  test('new items without ratings default to 1000 and their matches ARE applied (2.0.3)', () => {
    setLocal({ items: {} });
    const heat = item('Movies', 'Heat'), ronin = item('Movies', 'Ronin');
    pullCloud(cloud({ items: byId([doc(heat), doc(ronin)]), matchLog: [match('dOther-1', heat, ronin)] }));
    const s = state();
    assert.deepEqual(rating(s.items[heat.id]), [1016, 1, 0]);
    assert.deepEqual(rating(s.items[ronin.id]), [984, 0, 1]);
    assert.deepEqual(s.matchLog.map(m => m.id), ['dOther-1']);
  });

  test('after a baseline reseed, baked ratings are adopted and post-reset matches still apply', () => {
    // resetSharedBaseline() bakes ratings into item docs and wipes all matches, so any
    // match a pull delivers is strictly newer than the bake and must be applied.
    setLocal({ items: {} });
    const heat = item('Movies', 'Heat', { elo: 1200, wins: 10, losses: 0 });
    const ronin = item('Movies', 'Ronin', { elo: 800, wins: 0, losses: 10 });
    pullCloud(cloud({ items: byId([heat, ronin]), matchLog: [match('dOther-1', ronin, heat)] }));
    const s = state();
    const [roninElo, heatElo] = eloAfter(ronin, heat);
    assert.deepEqual(rating(s.items[heat.id]), [heatElo, 10, 1]);
    assert.deepEqual(rating(s.items[ronin.id]), [roninElo, 1, 10]);
  });
});

// --- deletions -----------------------------------------------------------------

describe('item tombstones', () => {
  test('an incoming delete removes the local item', () => {
    const heat = item('Movies', 'Heat');
    setLocal({ items: byId([heat]) });
    importFile(exportPayload({ itemDeletes: [{ itemId: heat.id, ts: 50, deviceId: 'dOther', title: 'Heat', cat: 'Movies' }] }));
    const s = state();
    assert.equal(s.items[heat.id], undefined);
    assert.deepEqual(s.itemDeletes.map(t => t.itemId), [heat.id]);
  });

  test('a local delete blocks a stale device from resurrecting the item', () => {
    const heat = item('Movies', 'Heat');
    setLocal({ items: {}, itemDeletes: [{ itemId: heat.id, ts: 50, deviceId: 'dMe', title: 'Heat', cat: 'Movies' }] });
    importFile(exportPayload({ items: byId([heat]) }));
    assert.equal(state().items[heat.id], undefined);
  });

  test('an undelete newer than the delete lets the item sync again (2.2.0)', () => {
    const heat = item('Movies', 'Heat');
    setLocal({ items: {}, itemDeletes: [{ itemId: heat.id, ts: 50, deviceId: 'dMe', title: 'Heat', cat: 'Movies' }] });
    importFile(exportPayload({
      items: byId([heat]),
      itemUndeletes: [{ itemId: heat.id, ts: 60, deviceId: 'dOther', title: 'Heat', cat: 'Movies' }],
    }));
    assert.ok(state().items[heat.id]);
  });

  test('a delete and undelete with the same timestamp resolve to deleted', () => {
    const heat = item('Movies', 'Heat');
    setLocal({ items: byId([heat]) });
    importFile(exportPayload({
      itemDeletes: [{ itemId: heat.id, ts: 50, deviceId: 'dA', title: 'Heat', cat: 'Movies' }],
      itemUndeletes: [{ itemId: heat.id, ts: 50, deviceId: 'dB', title: 'Heat', cat: 'Movies' }],
    }));
    assert.equal(state().items[heat.id], undefined);
  });

  test('tombstone logs collapse to the latest entry per item id', () => {
    const heat = item('Movies', 'Heat');
    setLocal({ items: {}, itemDeletes: [{ itemId: heat.id, ts: 10, deviceId: 'dMe', title: 'Heat', cat: 'Movies' }] });
    importFile(exportPayload({ itemDeletes: [
      { itemId: heat.id, ts: 30, deviceId: 'dOther', title: 'Heat', cat: 'Movies' },
      { itemId: heat.id, ts: 20, deviceId: 'dOther', title: 'Heat', cat: 'Movies' },
    ] }));
    assert.deepEqual(state().itemDeletes.map(t => t.ts), [30]);
  });
});

describe('category tombstones (2.5.0)', () => {
  test('an incoming category delete removes its name, schema, and items', () => {
    const dune = item('Books', 'Dune');
    setLocal({ cats: ['Movies', 'Books'], schema: { ...app.get('freshState().schema'), Books: { primary: 'Title', fields: [] } }, items: byId([dune]) });
    importFile(exportPayload({ catDeletes: [{ cat: 'Books', ts: 50, deviceId: 'dOther' }] }));
    const s = state();
    assert.ok(!s.cats.includes('Books'));
    assert.equal(s.schema.Books, undefined);
    assert.equal(s.items[dune.id], undefined);
  });

  test('an item with no tombstone of its own cannot resurrect a deleted category', () => {
    setLocal({ catDeletes: [{ cat: 'Books', ts: 50, deviceId: 'dMe' }] });
    const late = item('Books', 'Added after the delete');
    importFile(exportPayload({ cats: ['Books'], schema: { Books: { primary: 'Title', fields: [] } }, items: byId([late]) }));
    const s = state();
    assert.ok(!s.cats.includes('Books'));
    assert.equal(s.items[late.id], undefined);
  });
});

// --- schema --------------------------------------------------------------------

describe('schema adoption', () => {
  test('a brand-new field on a known category is adopted (2.5.1)', () => {
    setLocal();
    const local = app.get('state.schema.Movies.fields');
    importFile(exportPayload({ schema: { Movies: { primary: 'Title', fields: [...local, { name: 'Rating', required: false, filterable: true }] } } }));
    const fields = app.get('state.schema.Movies.fields');
    assert.deepEqual(fields.map(f => f.name), [...local.map(f => f.name), 'Rating']);
  });

  test('required/filterable on an already-shared field stay local-only', () => {
    setLocal();
    const local = app.get('state.schema.Movies.fields');
    importFile(exportPayload({ schema: { Movies: { primary: 'Title', fields: local.map(f => ({ ...f, required: true, filterable: true })) } } }));
    assert.deepEqual(app.get('state.schema.Movies.fields'), local);
  });

  test('an incoming identity flag rekeys local items before union, so nothing duplicates (2.5.2 / 2.7.3)', () => {
    // Local: Year is not identity, so Dune's id is itemKey(Movies, Dune).
    const oldDune = item('Movies', 'Dune', { fields: { Year: '2021' }, elo: 1100, wins: 4 });
    const other = item('Movies', 'Heat');
    setLocal({ items: byId([oldDune, other]), matchLog: [match('dMe-1', oldDune, other)] });
    // Remote already flagged Year as identity, so its Dune id includes the Year suffix.
    const suffix = app.call('identitySuffixForFields', [{ name: 'Year' }], { Year: '2021' });
    const newDune = item('Movies', 'Dune', { suffix, fields: { Year: '2021' }, elo: 1000 });
    const idFields = [{ name: 'Year', required: true, identity: true }, { name: 'Director', required: false }];
    importFile(exportPayload({ schema: { Movies: { primary: 'Title', fields: idFields } }, items: byId([newDune]) }));

    const s = state();
    const dunes = Object.values(s.items).filter(i => i.title === 'Dune');
    assert.equal(dunes.length, 1, '2.5.2: exactly one Dune, not the original plus a duplicate');
    assert.equal(dunes[0].id, newDune.id, 'local copy moved onto the identity-aware id');
    assert.deepEqual(rating(dunes[0]), [1100, 4, 0], 'and kept its local rating');
    assert.equal(s.schema.Movies.fields.find(f => f.name === 'Year').identity, true);
    assert.ok(s.itemDeletes.some(t => t.itemId === oldDune.id), '2.7.3: old id tombstoned so other devices drop it');
    assert.equal(s.matchLog[0].wid, newDune.id, 'local matchLog follows the rekey');
  });
});

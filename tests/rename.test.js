// Renaming an item (title or identity-field value) across two devices. An item's id
// is derived from its title, so a rename moves it to a new id. It syncs as an
// itemDeletes tombstone for the old id carrying `renamedTo: newId` (2.17.0), which
// tells a receiving device to MOVE its own copy (rating, matches, history) instead of
// deleting it. A tombstone without `renamedTo` is a plain delete, as before.
//
// Each test drives two independent pages: device A (renames through the real Library
// edit form) and device B. Both start synced: Heat beat Ronin 3 times, 1048 vs 952.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let A, B;
beforeEach(() => { A = loadApp(); B = loadApp(); seed(A, 'dA'); seed(B, 'dB'); });
afterEach(() => { A.close(); B.close(); });

// --- helpers -------------------------------------------------------------------

const key = title => A.call('itemKey', 'Movies', title);
const HEAT = () => key('Heat');

function seed(app, deviceId) {
  const heat = app.call('itemKey', 'Movies', 'Heat'), ronin = app.call('itemKey', 'Movies', 'Ronin');
  const s = app.get('freshState()');
  s.settings.deviceId = deviceId;
  s.items = {
    [heat]: { id: heat, cat: 'Movies', title: 'Heat', fields: { Year: '1995' }, elo: 1048, wins: 3, losses: 0, hidden: false, updatedAt: 1 },
    [ronin]: { id: ronin, cat: 'Movies', title: 'Ronin', fields: {}, elo: 952, wins: 0, losses: 3, hidden: false, updatedAt: 1 },
  };
  s.matchLog = [1, 2, 3].map(n => ({ id: 'dA-' + n, cat: 'Movies', wid: heat, lid: ronin, ts: n, seq: n }));
  s.history = [{ type: 'standard', category: 'Movies', timestamp: 3,
    winner: { id: heat, title: 'Heat', eloChange: 15 }, loser: { id: ronin, title: 'Ronin', eloChange: -15 } }];
  app.setState(s);
}
// Renames through the real UI path: Library -> edit -> change title -> Save.
function rename(app, fromTitle, toTitle) {
  const id = app.call('itemKey', 'Movies', fromTitle);
  app.run(`document.getElementById('sel-cat').value = 'Movies'; renderLibrary(); editItem(${JSON.stringify(id)});`);
  app.window.document.getElementById('edit-primary-' + id).value = toTitle;
  app.run(`saveItem(${JSON.stringify(id)})`);
}

// Records a vote on a device exactly as vote() does to state (without the Rank UI).
function voteOn(app, winnerTitle, loserTitle) {
  const w = app.call('itemKey', 'Movies', winnerTitle), l = app.call('itemKey', 'Movies', loserTitle);
  app.run(`eloUpdate(state.items[${JSON.stringify(w)}], state.items[${JSON.stringify(l)}]); recordMatch('Movies', ${JSON.stringify(w)}, ${JSON.stringify(l)});`);
}

// What pullFromFirestore() hands mergeImport() after `src` uploads: item docs without
// ratings, matches, and tombstones round-tripped through the same doc mapping the
// upload/pull code uses (tombstoneDoc() on the sender, tombstoneFromDoc() on the receiver).
function pull(dst, src) {
  const s = src.get('state');
  const items = {};
  Object.values(s.items).forEach(i => { items[i.id] = { id: i.id, cat: i.cat, title: i.title, fields: i.fields, updatedAt: i.updatedAt }; });
  const docs = src.get(`state.itemDeletes.map(tombstoneDoc)`);
  const itemDeletes = dst.get(`${JSON.stringify(docs)}.map(tombstoneFromDoc)`);
  const incoming = { items, cats: s.cats, schema: s.schema, matchLog: s.matchLog,
    itemDeletes, itemUndeletes: s.itemUndeletes, catDeletes: s.catDeletes, catUndeletes: s.catUndeletes };
  dst.run(`mergeImport(${JSON.stringify(incoming)}, { cloudOrigin: true })`);
}
// File path: src exports, dst imports (importData() -> mergeImport(migrateData(json))).
function importFrom(dst, src) {
  dst.run(`mergeImport(migrateData(${JSON.stringify(src.get('buildExportPayload()'))}))`);
}

const items = app => app.get('state.items');
const rating = i => [i.elo, i.wins, i.losses];
const titles = app => Object.values(items(app)).map(i => i.title).sort();
function orphanedMatches(app) {
  const s = app.get('state');
  return s.matchLog.filter(m => !s.items[m.wid] || !s.items[m.lid]).map(m => m.id);
}

// --- the renaming device -------------------------------------------------------

describe('on the renaming device', () => {
  test('matches and history follow the item, so Undo still works', () => {
    rename(A, 'Heat', 'Heat (1995)');
    const newId = key('Heat (1995)');
    assert.deepEqual(rating(items(A)[newId]), [1048, 3, 0]);
    assert.deepEqual(orphanedMatches(A), [], 'matchLog entries point at the new id');
    assert.equal(A.get('state.history[0].winner.id'), newId);
    assert.equal(A.get('canUndo(state.history[0])'), true);
  });

  test('records a tombstone for the old id with renamedTo, kept off the Deleted Items list', () => {
    rename(A, 'Heat', 'Heat (1995)');
    const t = A.get('state.itemDeletes');
    assert.equal(t.length, 1);
    assert.equal(t[0].itemId, HEAT(), 'tombstone stays on the OLD id (remapItemIds must not rewrite it)');
    assert.equal(t[0].renamedTo, key('Heat (1995)'));
    A.run('renderDeletedItems()');
    assert.match(A.window.document.getElementById('deleted-items-list').textContent, /No deleted items/);
  });

  test('renaming back to an earlier title records an undelete, so the item survives the next sync', () => {
    rename(A, 'Heat', 'Heat (1995)');
    rename(A, 'Heat (1995)', 'Heat');
    assert.equal(A.get(`currentlyTombstonedIds(state.itemDeletes, state.itemUndeletes).has(${JSON.stringify(HEAT())})`), false);
    pull(A, B); // any sync runs the tombstone pass
    assert.deepEqual(titles(A), ['Heat', 'Ronin']);
    assert.deepEqual(rating(items(A)[HEAT()]), [1048, 3, 0]);
  });
});

// --- the receiving device ------------------------------------------------------

describe('on the receiving device', () => {
  test('a cloud pull moves its own copy and keeps its rating (not 1000/0W)', () => {
    rename(A, 'Heat', 'Heat (1995)');
    pull(B, A);
    const newId = key('Heat (1995)');
    assert.deepEqual(titles(B), ['Heat (1995)', 'Ronin']);
    assert.deepEqual(rating(items(B)[newId]), [1048, 3, 0]);
    assert.deepEqual(orphanedMatches(B), []);
    assert.equal(B.get('state.history[0].winner.id'), newId);
  });

  test('the moved copy survives later syncs (its rename tombstone stays on the old id)', () => {
    rename(A, 'Heat', 'Heat (1995)');
    pull(B, A);
    assert.deepEqual(B.get('state.itemDeletes').map(t => t.itemId), [HEAT()], 'not rewritten onto the new id');
    pull(B, A);
    importFrom(B, A);
    assert.deepEqual(titles(B), ['Heat (1995)', 'Ronin']);
    assert.deepEqual(rating(items(B)[key('Heat (1995)')]), [1048, 3, 0]);
  });

  test('renaming back and forth repeatedly keeps one live item on both devices', () => {
    // The third rename is the one that goes wrong if remapItemIds() rewrites tombstones:
    // the first rename's tombstone (Heat -> Heat (1995)) would become a delete of the
    // item's current id.
    rename(A, 'Heat', 'Heat (1995)');
    rename(A, 'Heat (1995)', 'Heat');
    rename(A, 'Heat', 'Heat (1995)');
    assert.deepEqual(titles(A), ['Heat (1995)', 'Ronin']);
    const renames = A.get('state.itemDeletes').filter(t => t.renamedTo);
    assert.deepEqual(renames.filter(t => t.itemId === t.renamedTo), [], 'no rename tombstone was rewritten to point at itself');
    assert.equal(renames.length, 3, 'one rename tombstone per rename, each still on its own old id');
    pull(B, A);
    pull(A, B);
    for (const [name, dev] of [['A', A], ['B', B]]) {
      assert.deepEqual(titles(dev), ['Heat (1995)', 'Ronin'], name);
      assert.deepEqual(rating(items(dev)[key('Heat (1995)')]), [1048, 3, 0], name);
    }
  });

  test('a file import gives the same result', () => {
    rename(A, 'Heat', 'Heat (1995)');
    importFrom(B, A);
    assert.deepEqual(titles(B), ['Heat (1995)', 'Ronin']);
    assert.deepEqual(rating(items(B)[key('Heat (1995)')]), [1048, 3, 0]);
    assert.deepEqual(orphanedMatches(B), []);
  });

  test('rename then rename back: nothing is deleted on either device', () => {
    rename(A, 'Heat', 'Heat (1995)');
    rename(A, 'Heat (1995)', 'Heat');
    pull(B, A);
    assert.deepEqual(titles(B), ['Heat', 'Ronin']);
    assert.deepEqual(rating(items(B)[HEAT()]), [1048, 3, 0]);
    pull(A, B);
    assert.deepEqual(titles(A), ['Heat', 'Ronin']);
  });

  test('a chain of renames resolves to the final title, whatever order the tombstones arrive in', () => {
    rename(A, 'Heat', 'Heat 2');
    rename(A, 'Heat 2', 'Heat 3');
    const B2 = loadApp(); seed(B2, 'dB2');
    try {
      pull(B, A);
      assert.deepEqual(titles(B), ['Heat 3', 'Ronin']);
      assert.deepEqual(rating(items(B)[key('Heat 3')]), [1048, 3, 0]);
      // Same facts, tombstones in reverse order.
      A.run('state.itemDeletes.reverse()');
      pull(B2, A);
      assert.deepEqual(titles(B2), ['Heat 3', 'Ronin']);
      assert.deepEqual(rating(items(B2)[key('Heat 3')]), [1048, 3, 0]);
    } finally { B2.close(); }
  });

  test('a match recorded against the old id (before hearing of the rename) lands on the renamed item', () => {
    rename(A, 'Heat', 'Heat (1995)');
    voteOn(B, 'Heat', 'Ronin'); // B still calls it Heat
    const heatAfter = items(B)[HEAT()].elo;
    pull(A, B);
    const newId = key('Heat (1995)');
    assert.deepEqual(rating(items(A)[newId]), [heatAfter, 4, 0], 'cloud: applied to the renamed item');
    assert.deepEqual(orphanedMatches(A), []);
  });

  test('the same late match arriving by file import also lands on the renamed item', () => {
    rename(A, 'Heat', 'Heat (1995)');
    voteOn(B, 'Heat', 'Ronin');
    const heatAfter = items(B)[HEAT()].elo;
    importFrom(A, B);
    assert.deepEqual(rating(items(A)[key('Heat (1995)')]), [heatAfter, 4, 0]);
    assert.deepEqual(orphanedMatches(A), []);
  });
});

// --- collisions: the renamed-to id already exists on the receiver ---------------

describe('when the receiver already has an item at the new id', () => {
  function bAlsoHasHeat1995() {
    // B independently added "Heat (1995)" and voted it over Ronin once.
    const id = key('Heat (1995)');
    B.run(`state.items[${JSON.stringify(id)}] = { id: ${JSON.stringify(id)}, cat: 'Movies', title: 'Heat (1995)', fields: { Year: '1995', Director: 'Michael Mann' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 5 };`);
    voteOn(B, 'Heat (1995)', 'Ronin');
    return id;
  }

  test('the two entries are merged: W/L summed, rating from the entry with more matches, fields last-write-wins', () => {
    const id = bAlsoHasHeat1995();
    rename(A, 'Heat', 'Heat (1995)'); // A's edit is newer than B's add
    pull(B, A);
    assert.deepEqual(titles(B), ['Heat (1995)', 'Ronin'], 'one entry, not two');
    const merged = items(B)[id];
    assert.equal(merged.wins, 3 + 1);
    assert.equal(merged.losses, 0);
    assert.equal(merged.elo, 1048, "Heat's rating (3 matches) beats Heat (1995)'s (1 match)");
    assert.equal(merged.fields.Year, '1995');
    assert.deepEqual(orphanedMatches(B), []);
  });

  test('a match between the two merged entries is skipped, not applied to the item against itself', () => {
    const id = bAlsoHasHeat1995();
    voteOn(B, 'Heat (1995)', 'Heat'); // B plays its two entries against each other
    rename(A, 'Heat', 'Heat (1995)');
    const before = items(A)[id];
    pull(A, B); // delivers B's "Heat (1995) beat Heat": both sides now resolve to the same item on A
    const after = items(A)[id];
    assert.ok(Number.isFinite(after.elo), 'no NaN from updating an item against itself');
    assert.equal(after.wins - before.wins, 1, "only B's ordinary win over Ronin applies");
    assert.equal(after.losses - before.losses, 0, 'the self-match adds nothing');
  });
});

// --- plain deletes are unchanged -------------------------------------------------

describe('plain deletes', () => {
  test('deleting the item after renaming it still deletes it everywhere', () => {
    rename(A, 'Heat', 'Heat (1995)');
    A.window.confirm = () => true;
    A.run(`deleteItem(${JSON.stringify(key('Heat (1995)'))})`);
    pull(B, A);
    assert.deepEqual(titles(B), ['Ronin']);
  });

  test('an old-format tombstone without renamedTo deletes, as before', () => {
    const incoming = { items: {}, cats: ['Movies'], schema: {}, matchLog: [],
      itemDeletes: [{ itemId: HEAT(), ts: 50, deviceId: 'dOld', title: 'Heat', cat: 'Movies' }],
      itemUndeletes: [], catDeletes: [], catUndeletes: [] };
    B.run(`mergeImport(${JSON.stringify(incoming)}, { cloudOrigin: true })`);
    assert.deepEqual(titles(B), ['Ronin']);
  });
});

// --- Firestore doc mapping ------------------------------------------------------

describe('Firestore tombstone docs', () => {
  test('renamedTo survives the upload -> pull round trip', () => {
    const t = { itemId: 'iold', ts: 5, deviceId: 'dA', title: 'Heat', cat: 'Movies', renamedTo: 'inew' };
    assert.deepEqual(A.get(`tombstoneFromDoc(tombstoneDoc(${JSON.stringify(t)}))`), t);
  });

  test('a plain tombstone round-trips without gaining a renamedTo', () => {
    const t = { itemId: 'iold', ts: 5, deviceId: 'dA', title: 'Heat', cat: 'Movies' };
    assert.deepEqual(A.get(`tombstoneFromDoc(tombstoneDoc(${JSON.stringify(t)}))`), t);
  });
});

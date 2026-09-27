// Re-adding something that was deleted. Item ids come from titles (itemKey()), so
// adding "Heat" after "Heat" was deleted lands on the same id — whose tombstone is
// still active. Without an undelete, the next sync removes the new item again, on
// every device (the "Superman" trap from 2.2.0). Every path that creates an item —
// the Library add form, CSV bulk add, CSV replace/create — must record an undelete
// when it lands on a tombstoned id, the same way a rename back does (2.17.0).
//
// Two devices, A and B, start synced with Heat and Ronin.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { pull, importFrom } = require('./helpers/sync');

let A, B;
beforeEach(() => { A = loadApp(); B = loadApp(); seed(A, 'dA'); seed(B, 'dB'); });
afterEach(() => { A.close(); B.close(); });

// --- helpers -------------------------------------------------------------------

const key = (title, cat = 'Movies') => A.call('itemKey', cat, title);

function seed(app, deviceId) {
  const s = app.get('freshState()');
  s.settings.deviceId = deviceId;
  for (const [title, elo, wins, losses] of [['Heat', 1048, 3, 0], ['Ronin', 952, 0, 3]]) {
    const id = app.call('itemKey', 'Movies', title);
    s.items[id] = { id, cat: 'Movies', title, fields: {}, elo, wins, losses, hidden: false, updatedAt: 1 };
  }
  app.setState(s);
}

function deleteViaUI(app, title) {
  app.window.confirm = () => true;
  app.run(`deleteItem(${JSON.stringify(key(title))})`);
}

// Adds through the real Library add form.
function addViaUI(app, title, fields = {}) {
  app.run(`document.getElementById('sel-cat').value = 'Movies'; renderLibrary();`);
  const doc = app.window.document;
  doc.getElementById('inp-primary').value = title;
  for (const [name, val] of Object.entries(fields)) doc.getElementById('field-' + name).value = val;
  app.run('addItem()');
}

const titles = (app, cat = 'Movies') => Object.values(app.get('state.items')).filter(i => i.cat === cat).map(i => i.title).sort();
const isTombstoned = (app, id) => app.get(`currentlyTombstonedIds(state.itemDeletes, state.itemUndeletes).has(${JSON.stringify(id)})`);

// --- Library add form ------------------------------------------------------------

describe('adding an item whose title was deleted', () => {
  test('on the same device: the new item survives the next sync', () => {
    deleteViaUI(A, 'Heat');
    addViaUI(A, 'Heat');
    assert.equal(isTombstoned(A, key('Heat')), false, 'an undelete now outranks the old tombstone');
    pull(A, B); // B still has the old Heat, and no tombstone of its own
    assert.deepEqual(titles(A), ['Heat', 'Ronin']);
  });

  test('it reaches the other device, which also had the delete', () => {
    deleteViaUI(A, 'Heat');
    pull(B, A);
    assert.deepEqual(titles(B), ['Ronin'], 'precondition: the delete synced');
    addViaUI(A, 'Heat');
    pull(B, A);
    assert.deepEqual(titles(B), ['Heat', 'Ronin']);
    importFrom(A, B);
    assert.deepEqual(titles(A), ['Heat', 'Ronin']);
  });

  test('also when the delete came from the other device', () => {
    deleteViaUI(B, 'Heat');
    pull(A, B);
    assert.deepEqual(titles(A), ['Ronin'], 'precondition: A learned the delete');
    addViaUI(A, 'Heat');
    pull(A, B);
    pull(B, A);
    assert.deepEqual(titles(A), ['Heat', 'Ronin']);
    assert.deepEqual(titles(B), ['Heat', 'Ronin']);
  });

  test('the re-added item starts fresh, and drops off the Deleted Items list', () => {
    deleteViaUI(A, 'Heat');
    addViaUI(A, 'Heat');
    const heat = A.get('state.items')[key('Heat')];
    assert.deepEqual([heat.elo, heat.wins, heat.losses], [1000, 0, 0]);
    A.run('renderDeletedItems()');
    assert.match(A.window.document.getElementById('deleted-items-list').textContent, /No deleted items/);
  });

  test('adding a never-deleted title records no undelete', () => {
    addViaUI(A, 'Collateral');
    assert.deepEqual(A.get('state.itemUndeletes'), []);
  });
});

// --- CSV --------------------------------------------------------------------------

describe('CSV imports onto deleted titles', () => {
  test('bulk add re-creates a deleted item that survives sync', () => {
    deleteViaUI(A, 'Heat');
    A.run(`bulkAddCSVImport({ category: 'Movies', items: [{ title: 'Heat', fields: {} }, { title: 'Collateral', fields: {} }] })`);
    pull(A, B);
    assert.deepEqual(titles(A), ['Collateral', 'Heat', 'Ronin']);
    pull(B, A);
    assert.deepEqual(titles(B), ['Collateral', 'Heat', 'Ronin']);
  });

  test('replace keeps the re-imported rows after sync', () => {
    // Replace tombstones every item in the category, then re-creates the CSV's rows —
    // at the same ids for unchanged titles. Without undeletes, those rows are deleted
    // again by the very next sync.
    A.window.confirm = () => true;
    A.window.prompt = () => '2';
    A.run(`resolveCSVImport({ category: 'Movies', primary: 'Title', fields: [], items: [{ title: 'Heat', fields: {} }, { title: 'Thief', fields: {} }] })`);
    assert.deepEqual(titles(A), ['Heat', 'Thief']);
    pull(A, B);
    assert.deepEqual(titles(A), ['Heat', 'Thief'], 'Ronin stays deleted; Heat and Thief survive');
    pull(B, A);
    assert.deepEqual(titles(B), ['Heat', 'Thief']);
  });

  test('importing a CSV for a previously deleted category brings the category back', () => {
    A.window.confirm = () => true;
    A.run(`resolveCSVImport({ category: 'Books', primary: 'Title', fields: [], items: [{ title: 'Dune', fields: {} }] })`);
    A.run(`editingCat = 'Books'; confirmDeleteCat()`);
    assert.ok(!A.get('state.cats').includes('Books'), 'precondition: category deleted');
    A.run(`resolveCSVImport({ category: 'Books', primary: 'Title', fields: [], items: [{ title: 'Dune', fields: {} }] })`);
    pull(A, B);
    assert.ok(A.get('state.cats').includes('Books'));
    assert.deepEqual(titles(A, 'Books'), ['Dune']);
    pull(B, A);
    assert.deepEqual(titles(B, 'Books'), ['Dune']);
  });
});

// Turning on an identity field for a category that's already synced. Every item in the
// category moves to a new id (the identity value is part of the id — see itemKey()), so
// the change has to reach other devices as a rename of each item, not a delete: a device
// that already has the items must keep their ratings, and a device joining later must
// still be able to replay every comparison. Runs the real upload/pull/reset/adopt code
// against the in-memory Firestore (tests/helpers/firestore.js).
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect } = require('./helpers/firestore');

let db, A, B;
const others = [];
beforeEach(async () => {
  db = createFirestore();
  A = loadApp(); B = loadApp();
  connect(A, db, { email: 'a@example.com' });
  connect(B, db, { email: 'b@example.com' });
  seed(A, 'dA');
  B.run(`state.settings.deviceId = 'dB'`);
  // Both devices synced, with some history: Heat beat Ronin three times.
  for (let n = 0; n < 3; n++) voteOn(A, 'Heat', 'Ronin');
  await cloud(A, 'uploadToFirestore()');
  await cloud(B, 'pullFromFirestore()');
  assert.deepEqual(rankings(B), rankings(A), 'setup: both devices start in sync');
});
afterEach(() => { [A, B, ...others.splice(0)].forEach(app => app.close()); });

// --- helpers -------------------------------------------------------------------

const MOVIES = [['Heat', '1995'], ['Ronin', '1998'], ['Thief', '1981']];

function seed(app, deviceId) {
  const s = app.get('freshState()');
  s.settings.deviceId = deviceId;
  for (const [title, Year] of MOVIES) {
    const id = app.call('itemKey', 'Movies', title);
    s.items[id] = { id, cat: 'Movies', title, fields: { Year, Director: '' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 };
  }
  app.setState(s);
}
function newDevice() {
  const app = loadApp();
  connect(app, db, { email: 'c@example.com' });
  others.push(app);
  return app;
}
async function cloud(app, call) {
  const ok = await app.window.eval(call);
  if (ok !== undefined) assert.equal(ok, true, `${call} failed`);
}
// An item's current id under the device's current schema, from its title and Year
// (Year defaults to the seeded one; it only matters once Year is an identity field).
function idOf(app, title, Year = MOVIES.find(m => m[0] === title)[1]) {
  return app.get(`itemKey('Movies', ${JSON.stringify(title)}, identitySuffixFor('Movies', { Year: ${JSON.stringify(Year)} }))`);
}
// Records a vote exactly as vote() does to state (without the Rank UI). Takes titles of
// seeded movies, or [title, Year] pairs.
function voteOn(app, winner, loser) {
  const ref = x => JSON.stringify(Array.isArray(x) ? idOf(app, ...x) : idOf(app, x));
  const w = ref(winner), l = ref(loser);
  app.run(`eloUpdate(state.items[${w}], state.items[${l}]); recordMatch('Movies', ${w}, ${l});`);
}
// Library -> "Fields" -> 🔑 on Year -> Save, through the real Schema Editor controls.
function flagYearAsIdentity(app, on = true) {
  const doc = app.window.document;
  app.run(`document.getElementById('sel-cat').value = 'Movies'; openSchemaEditor();`);
  const row = [...doc.querySelectorAll('#schema-fields .field-row')].find(r => r.querySelector('.field-name').textContent === 'Year');
  row.querySelector('[data-action="toggleIdentity"]').click();
  [...doc.querySelectorAll('#view-schema button')].find(b => b.textContent.trim().startsWith('Save')).click();
  assert.equal(!!app.get("state.schema.Movies.fields.find(f => f.name === 'Year').identity"), on, `setup: Year identity is ${on ? 'on' : 'off'}`);
}
function addMovie(app, title, Year) {
  app.run(`document.getElementById('sel-cat').value = 'Movies'; onLibCatChange();`);
  const doc = app.window.document;
  doc.getElementById('inp-primary').value = title;
  doc.getElementById('field-Year').value = Year;
  app.run('addItem()');
}

function rankings(app) {
  const items = Object.values(app.get('state.items'));
  return Object.fromEntries(items.sort((a, b) => a.id.localeCompare(b.id))
    .map(i => [i.id, { title: i.title, fields: i.fields, elo: i.elo, wins: i.wins, losses: i.losses }]));
}
const heat = app => rankings(app)[idOf(app, 'Heat')];

// --- tests ---------------------------------------------------------------------

describe('turning on an identity field on a synced category', () => {
  test('a device that already has the items keeps their ratings', async () => {
    flagYearAsIdentity(A);
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    assert.equal(B.get("state.schema.Movies.fields.find(f => f.name === 'Year').identity"), true, 'the flag reaches B');
    assert.deepEqual(rankings(B), rankings(A), 'B had every Movie at 1000, 0-0');
    assert.deepEqual([heat(B).elo > 1000, heat(B).wins], [true, 3]);
  });

  test('a device joining afterwards can still replay every comparison', async () => {
    flagYearAsIdentity(A);
    await cloud(A, 'uploadToFirestore()');
    const C = newDevice();
    await cloud(C, 'pullFromFirestore()');
    assert.deepEqual(rankings(C), rankings(A), 'the old matches pointed at deleted ids');
  });

  test('a vote the other device made before hearing of the change counts on both', async () => {
    voteOn(B, 'Thief', 'Heat');
    await cloud(B, 'uploadToFirestore()');
    flagYearAsIdentity(A);
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rankings(B), rankings(A));
    assert.equal(heat(A).losses, 1, "B's vote reached A, against Heat's new id");
  });

  test('an item deleted and re-added before the change survives it on both devices', async () => {
    A.run(`deleteItem(${JSON.stringify(idOf(A, 'Thief'))})`);
    addMovie(A, 'Thief', '1981');
    voteOn(A, 'Thief', 'Ronin');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    flagYearAsIdentity(A);
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    await cloud(A, 'pullFromFirestore()');
    for (const [name, app] of [['A', A], ['B', B]]) {
      assert.ok(rankings(app)[idOf(app, 'Thief')], `Thief still exists on ${name}`);
    }
    assert.deepEqual(rankings(B), rankings(A));
    // The old delete stays on the old id: rewriting it onto Thief's new id (without its
    // undelete) invented a deletion for an id that was never deleted.
    const newIds = MOVIES.map(([t]) => idOf(A, t));
    assert.deepEqual(A.get('state.itemDeletes').filter(t => newIds.includes(t.itemId)), [], 'no tombstone on a new id');
  });

  test('turning it off and on again keeps every item on both devices', async () => {
    flagYearAsIdentity(A);
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    // Off again on A (other devices never adopt identity being turned off), then on.
    flagYearAsIdentity(A, false);
    flagYearAsIdentity(A);
    voteOn(A, 'Ronin', 'Heat');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.equal(Object.keys(rankings(A)).length, 3, 'all three Movies still on A');
    assert.deepEqual(rankings(B), rankings(A));
  });

  test('the moved items are not listed under Deleted Items', () => {
    flagYearAsIdentity(A);
    A.run('renderDeletedItems()');
    assert.match(A.window.document.getElementById('deleted-items-list').textContent, /No deleted items/);
  });

  test('two items can then share a title, and both sync', async () => {
    flagYearAsIdentity(A);
    addMovie(A, 'Heat', '1986');
    voteOn(A, ['Heat', '1986'], 'Ronin');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    const heats = Object.values(B.get('state.items')).filter(i => i.title === 'Heat').map(i => i.fields.Year).sort();
    assert.deepEqual(heats, ['1986', '1995']);
    assert.deepEqual(rankings(B), rankings(A));
  });
});

describe('pulling items keyed before an identity field was turned on', () => {
  // Found live with Movies: clear the device, import a file without the category's items,
  // turn the identity field on, run Reset. Reset's first pull brought back every cloud doc
  // still keyed by title alone, and the reseed kept them that way.
  async function clearImportFlagAndReset(app) {
    const file = A.get('buildExportPayload()');
    Object.keys(file.items).forEach(id => { if (file.items[id].cat === 'Movies') delete file.items[id]; });
    file.matchLog = [];
    app.run('clearAllDataCore()');
    app.run(`mergeImport(migrateData(${JSON.stringify(file)}))`);
    flagYearAsIdentity(app);
    await cloud(app, 'resetSharedBaseline()');
  }
  const ids = app => Object.keys(app.get('state.items')).sort();
  const fullIds = app => MOVIES.map(([t]) => idOf(app, t)).sort();

  test('a reset pull moves them to their full ids, with their matches', async () => {
    const heatBefore = heat(A);
    await clearImportFlagAndReset(B);
    assert.deepEqual(ids(B), fullIds(B), 'Movies came back under title-only ids');
    assert.deepEqual([heat(B).elo, heat(B).wins], [heatBefore.elo, 3], "Heat's matches followed it");
    await cloud(A, 'adoptFreshBaseline()');
    assert.deepEqual(rankings(A), rankings(B));
  });

  test('the same, when the cloud holds a previous reset\'s stored ratings', async () => {
    await cloud(A, 'resetSharedBaseline()');
    await cloud(B, 'adoptFreshBaseline()');
    const before = heat(A);
    await clearImportFlagAndReset(B);
    assert.deepEqual(ids(B), fullIds(B));
    assert.deepEqual([heat(B).elo, heat(B).wins], [before.elo, 3]);
  });

  test('an item already here under its full id is not duplicated by its old copy', async () => {
    flagYearAsIdentity(B);
    await cloud(B, 'pullFromFirestore({ full: true })');
    assert.deepEqual(ids(B), fullIds(B));
  });

  test('an item keyed under more identity fields than this device has keeps its id', () => {
    flagYearAsIdentity(B);
    const item = { cat: 'Movies', title: 'Heat', fields: { Year: '1995', Director: 'Michael Mann' } };
    item.id = B.get(`itemKey('Movies', 'Heat', 'Director=michael mann|Year=1995')`);
    assert.equal(B.call('localIdFor', item), item.id, 'mapping it down could merge two different items');
  });
});

describe('items on this device still keyed from before an identity field was turned on', () => {
  // Found live with Songs (2.18.5): after a Reset under 2.18.3, a device had Artist flagged
  // as identity but every Song on it keyed by title alone. 2.18.4's pull moved each
  // incoming copy onto its full id while the local copy stayed put, so all 101 songs the
  // pull delivered were added a second time. Here B is left in that state: Year flagged,
  // items still under their title-only ids.
  function leaveOffSchema(app) {
    app.run(`const f = state.schema.Movies.fields.find(f => f.name === 'Year'); f.identity = true; f.required = true;`);
    const titleOnly = MOVIES.map(([t]) => app.call('itemKey', 'Movies', t)).sort();
    assert.deepEqual(Object.keys(app.get('state.items')).sort(), titleOnly, 'setup: items still keyed by title alone');
  }
  const ids = app => Object.keys(app.get('state.items')).sort();
  const fullIds = app => MOVIES.map(([t]) => idOf(app, t)).sort();

  test('a pull moves them to their full ids instead of adding the pulled copies again', async () => {
    const heatBefore = heat(B);
    leaveOffSchema(B);
    await cloud(B, 'pullFromFirestore({ full: true })');
    assert.deepEqual(ids(B), fullIds(B), 'each movie is here twice: old id and full id');
    assert.deepEqual([heat(B).elo, heat(B).wins], [heatBefore.elo, 3], "Heat's rating moved with it");
  });

  test('copies already duplicated here are merged, keeping their ratings', async () => {
    const heatBefore = heat(B);
    leaveOffSchema(B);
    // What 2.18.4's pull left behind: a 1000, 0-0 copy of each item under its full id.
    B.run(`${JSON.stringify(MOVIES)}.forEach(([title, Year]) => {
      const id = itemKey('Movies', title, identitySuffixFor('Movies', { Year }));
      state.items[id] = { id, cat: 'Movies', title, fields: { Year, Director: '' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 2 };
    });`);
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(ids(B), fullIds(B));
    assert.deepEqual([heat(B).elo, heat(B).wins, heat(B).losses], [heatBefore.elo, 3, 0]);
  });

  test('the move reaches other devices as a rename', async () => {
    leaveOffSchema(B);
    await cloud(B, 'pullFromFirestore({ full: true })');
    await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rankings(A), rankings(B), "A still has the title-only copies");
    const C = newDevice();
    await cloud(C, 'pullFromFirestore()');
    assert.deepEqual(rankings(C), rankings(B), 'a new device got both the old and the new ids');
  });
});

describe('turning on an identity field after a baseline reset', () => {
  test('a device adopting afterwards gets the stored ratings under the new ids', async () => {
    await cloud(A, 'resetSharedBaseline()');
    flagYearAsIdentity(A);
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'adoptFreshBaseline()');
    assert.deepEqual(rankings(B), rankings(A), 'every Movie on B started from 1000');
  });
});

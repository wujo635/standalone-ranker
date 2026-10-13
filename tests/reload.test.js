// Reloading the page must give back exactly what was saved (2.21.2). save() didn't stamp
// a state started fresh (new device, Clear all data, Adopt, a Pull that adopts a reset),
// so the next load ran every migration from v1 on current data: v4 re-keyed items by
// title alone (same-titled items overwrote each other — the Oct 9 loss of Superman
// (1978)) and emptied matchLog (unsent votes never reached other devices; this device's
// own uploaded votes were applied again when pulled back).
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect } = require('./helpers/firestore');

let db, clock;
const open = [];
beforeEach(() => { db = createFirestore(); clock = 1_900_000_000_000; });
afterEach(() => open.splice(0).forEach(app => app.close()));

function page(email, saved) {
  const app = loadApp(saved ? { saved } : {});
  app.window.Date.now = () => (clock += 1000);
  connect(app, db, { email });
  open.push(app);
  return app;
}
// Closing and reopening the tab: a new page on the same saved data.
const reload = (app, email) => page(email, app.window.localStorage.getItem('ranker-v1'));
async function cloud(app, call) { assert.notEqual(await app.window.eval(call), false, `${call} failed`); }
function vote(app, w, l) {
  app.run(`(() => { const W = idOf(${JSON.stringify(w)}), L = idOf(${JSON.stringify(l)}); eloUpdate(state.items[W], state.items[L]); recordMatch('Movies', W, L); save(); })()`);
}
const MOVIES = [['Superman', '1978'], ['Superman', '2025'], ['Heat', '1995']];
// Movies with Year as an identity field, so the two Supermans are different items.
function seed(app) {
  app.run(`const y = state.schema.Movies.fields.find(f => f.name === 'Year'); y.identity = true; y.required = true;
    ${JSON.stringify(MOVIES)}.forEach(([title, Year]) => { const fields = { Year, Director: '' }; const id = itemKey('Movies', title, identitySuffixFor('Movies', fields));
      state.items[id] = { id, cat: 'Movies', title, fields, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 }; }); save();`);
}
function installIdOf(app) {
  app.run(`window.idOf = key => { const [title, Year] = key.split('|'); return itemKey('Movies', title, identitySuffixFor('Movies', { Year })); }`);
}
const view = app => Object.values(app.get('state.items')).map(i => `${i.title} (${i.fields.Year}) ${i.wins}-${i.losses}`).sort();

describe('reloading keeps what was saved (2.21.2)', () => {
  test('after Clear all data, a library with same-titled items survives a reload', () => {
    const A = page('a@x');
    A.run('clearAllDataCore()');
    seed(A);
    const B = reload(A, 'a@x');
    assert.deepEqual(view(B), view(A), 'Superman (1978) and (2025) collapsed into one');
  });

  test('after a Pull adopts a reset, votes made before reloading still reach the other device', async () => {
    const A = page('a@x'); seed(A); installIdOf(A);
    await cloud(A, 'uploadToFirestore()');
    let B = page('b@x'); await cloud(B, 'pullFromFirestore()');
    await cloud(A, 'resetSharedBaseline()');
    await cloud(B, 'pullFromFirestore()'); // adopts: B's state starts fresh
    installIdOf(B);
    vote(B, 'Superman|1978', 'Heat|1995'); vote(B, 'Superman|2025', 'Heat|1995');
    B = reload(B, 'b@x');
    assert.deepEqual(view(B).length, 3);
    await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(view(A), view(B));
    assert.deepEqual(view(A), ['Heat (1995) 0-2', 'Superman (1978) 1-0', 'Superman (2025) 1-0']);
  });

  test("this device's own uploaded votes aren't counted twice after a reload", async () => {
    const A = page('a@x');
    A.run('clearAllDataCore()');
    seed(A); installIdOf(A);
    for (let n = 0; n < 3; n++) vote(A, 'Heat|1995', 'Superman|1978');
    await cloud(A, 'uploadToFirestore()');
    const A2 = reload(A, 'a@x');
    await cloud(A2, 'pullFromFirestore()');
    assert.deepEqual(view(A2), view(A));
    assert.equal(A2.get('state.matchLog.length'), 3);
  });

  test('data already saved without a stamp loads as current, not as v1', () => {
    const A = page('a@x'); seed(A); installIdOf(A);
    vote(A, 'Superman|1978', 'Heat|1995');
    const saved = JSON.parse(A.window.localStorage.getItem('ranker-v1'));
    delete saved._meta; // what a 2.21.1-or-earlier device may hold right now
    const B = page('a@x', JSON.stringify(saved));
    assert.deepEqual(view(B), view(A));
    assert.equal(B.get('state.matchLog.length'), 1);
    assert.equal(B.get('state.settings.deviceId'), A.get('state.settings.deviceId'));
  });

  test('every save carries the schema stamp', () => {
    const A = page('a@x');
    A.run('clearAllDataCore(); save();');
    const saved = JSON.parse(A.window.localStorage.getItem('ranker-v1'));
    assert.equal(saved._meta.dataSchemaVersion, A.get('DATA_SCHEMA_VERSION'));
  });
});

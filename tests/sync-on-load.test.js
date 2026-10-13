// Pull once when the app opens (2.21.0): syncOnLoad(), started from onAuthStateChanged.
// Runs the real pull against the in-memory Firestore (tests/helpers/firestore.js).
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect, fakeFirebase } = require('./helpers/firestore');

let db, A, B;
const open = [];
beforeEach(async () => {
  db = createFirestore();
  A = page('a@example.com', 'dA'); B = page('b@example.com', 'dB');
  A.run(`['Heat', 'Ronin', 'Thief'].forEach(t => { const id = itemKey('Movies', t); state.items[id] = { id, cat: 'Movies', title: t, fields: { Year: '', Director: '' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 }; }); save();`);
  vote(A, 'Heat', 'Ronin');
  await cloud(A, 'uploadToFirestore()');
  await cloud(B, 'pullFromFirestore()');
  assert.deepEqual(rank(B), rank(A), 'setup: in sync');
});
afterEach(() => open.splice(0).forEach(app => app.close()));

function page(email, deviceId, opts) {
  const app = loadApp(opts);
  if (!opts?.beforeScript) connect(app, db, { email });
  app.run(`state.settings.deviceId = ${JSON.stringify(deviceId)}`);
  open.push(app);
  return app;
}
async function cloud(app, call) {
  assert.notEqual(await app.window.eval(call), false, `${call} failed`);
}
function vote(app, w, l) {
  app.run(`(() => { const W = itemKey('Movies', ${JSON.stringify(w)}), L = itemKey('Movies', ${JSON.stringify(l)}); eloUpdate(state.items[W], state.items[L]); recordMatch('Movies', W, L); save(); })()`);
}
const rank = app => Object.values(app.get('state.items')).sort((a, b) => a.id.localeCompare(b.id)).map(i => `${i.title} ${i.elo} ${i.wins}-${i.losses}`);
const lastToast = app => app.window.document.getElementById('toast').textContent;
const syncOnLoad = app => app.window.eval('syncOnLoad()');

describe('sync on load (2.21.0)', () => {
  test('a restored sign-in pulls once, with a toast saying what arrived', async () => {
    vote(A, 'Thief', 'Heat');
    await cloud(A, 'uploadToFirestore()');
    // B reopens the app: same saved data, the real cloud startup, then the session restores.
    const fb = fakeFirebase(db);
    const B2 = page('b@example.com', 'dB', { saved: B.window.localStorage.getItem('ranker-v1'), beforeScript: fb.install });
    fb.signIn('b@example.com');
    for (let n = 0; n < 50 && !lastToast(B2).startsWith('Synced'); n++) await new Promise(r => setTimeout(r, 0));
    assert.equal(lastToast(B2), 'Synced with the cloud — pulled 1 comparison');
    assert.deepEqual(rank(B2), rank(A));
    const reads = db.reads;
    fb.signIn('b@example.com'); // auth state can fire again; no second pull
    await new Promise(r => setTimeout(r, 0));
    assert.equal(db.reads, reads);
  });

  test("this device's own upload isn't reported as pulled when the app reopens (2.21.2)", async () => {
    // Reported live: add an item, 32 comparisons, Upload, reopen — the toast said it
    // pulled 1 item and 32 comparisons. The pull re-fetches this device's own docs (the
    // cursor can't safely move past them), but they bring nothing new.
    A.run(`(() => { const id = itemKey('Movies', 'Dune'); state.items[id] = { id, cat: 'Movies', title: 'Dune', fields: { Year: '', Director: '' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: Date.now() }; save(); })()`);
    for (let n = 0; n < 32; n++) vote(A, n % 2 ? 'Dune' : 'Heat', n % 2 ? 'Thief' : 'Dune');
    await cloud(A, 'uploadToFirestore()');
    const fb = fakeFirebase(db);
    const A2 = page('a@example.com', 'dA', { saved: A.window.localStorage.getItem('ranker-v1'), beforeScript: fb.install });
    fb.signIn('a@example.com');
    for (let n = 0; n < 50 && !lastToast(A2).startsWith('Synced'); n++) await new Promise(r => setTimeout(r, 0));
    assert.equal(lastToast(A2), 'Synced with the cloud — already up to date');
    assert.deepEqual(rank(A2), rank(A));
  });

  test('a rename pulled from another device counts as one item, not a deletion', async () => {
    const heatId = JSON.stringify(A.get("itemKey('Movies', 'Heat')"));
    A.run(`document.getElementById('sel-cat').value = 'Movies'; onLibCatChange(); renderLibrary(); editItem(${heatId});`);
    A.window.document.getElementById('edit-primary-' + A.get("itemKey('Movies', 'Heat')")).value = 'Heat II';
    A.run(`saveItem(${heatId})`);
    await cloud(A, 'uploadToFirestore()');
    await syncOnLoad(B);
    assert.equal(lastToast(B), 'Synced with the cloud — pulled 1 item');
  });

  test('nothing new still gets a toast', async () => {
    assert.equal(await syncOnLoad(B), true);
    assert.equal(lastToast(B), 'Synced with the cloud — already up to date');
  });

  test('items and deletions are counted too', async () => {
    A.run(`deleteItem(itemKey('Movies', 'Thief'))`);
    A.run(`(() => { const id = itemKey('Movies', 'Dune'); state.items[id] = { id, cat: 'Movies', title: 'Dune', fields: { Year: '', Director: '' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: Date.now() }; save(); })()`);
    await cloud(A, 'uploadToFirestore()');
    await syncOnLoad(B);
    assert.equal(lastToast(B), 'Synced with the cloud — pulled 1 item, 1 deletion');
  });

  test("doesn't run on a device that has never synced", async () => {
    const L = page('l@example.com', 'dL');
    L.run(`(() => { const id = itemKey('Movies', 'Local'); state.items[id] = { id, cat: 'Movies', title: 'Local', fields: {}, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 }; })()`);
    const reads = db.reads;
    assert.equal(await syncOnLoad(L), false);
    assert.equal(db.reads, reads);
    assert.deepEqual(Object.values(L.get('state.items')).map(i => i.title), ['Local']);
  });

  test("doesn't run signed out or offline", async () => {
    B.run('cloudUser = null');
    assert.equal(await syncOnLoad(B), false);
    const C = page('c@example.com', 'dC');
    await cloud(C, 'pullFromFirestore()');
    Object.defineProperty(C.window.navigator, 'onLine', { get: () => false, configurable: true });
    const reads = db.reads;
    assert.equal(await syncOnLoad(C), false);
    assert.equal(db.reads, reads);
  });

  test('a missed reset is adopted when nothing here is unsent', async () => {
    vote(A, 'Thief', 'Ronin');
    await cloud(A, 'resetSharedBaseline()');
    assert.equal(await syncOnLoad(B), true);
    assert.deepEqual(rank(B), rank(A));
    assert.match(lastToast(B), /adopted it/);
  });

  test('a missed reset is not adopted in the background while changes are unsent', async () => {
    vote(B, 'Ronin', 'Thief'); // unsent on B
    await cloud(A, 'resetSharedBaseline()');
    const before = rank(B), knownBefore = B.get('state.settings.knownBaselineId');
    assert.equal(await syncOnLoad(B), false);
    assert.deepEqual(rank(B), before, 'the unsent vote was discarded');
    assert.equal(B.get('state.settings.knownBaselineId'), knownBefore);
    assert.match(lastToast(B), /has 1 change that haven't been uploaded/);
    // A manual Pull still adopts.
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A));
  });

  test("an unreachable cloud is quiet", async () => {
    B.run(`cloudDb = { collection: () => { const e = new Error('offline'); e.code = 'unavailable'; throw e; } }`);
    B.window.document.getElementById('toast').textContent = '';
    assert.equal(await syncOnLoad(B), false);
    assert.equal(lastToast(B), '');
  });
});

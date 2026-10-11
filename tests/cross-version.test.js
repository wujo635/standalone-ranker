// Past releases and the current code side by side against one simulated cloud: what
// happens while devices upgrade one at a time, and when a tab left open on an old release
// keeps syncing. Past releases' index.html comes from git history (CI checks out with
// fetch-depth: 0); without history, these tests are skipped locally and fail in CI.
//
// "Reloading the page on a new version" = a new page on the current code, started from
// the old page's localStorage.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect } = require('./helpers/firestore');

const RELEASES = {
  // The last release before the packed baseline (2.19.0): resets baked ratings into one
  // item doc per item, and its pulls read only those.
  '2.18.8': '5f8804c0426612895f11eee6b334df27a855a492',
  // The last release before identity changes forced a reset (2.20.0).
  '2.19.0': '021fe0f3d27f1dc296ba8c4ab9b1ae3b8e240d5b',
};
function releaseHtml(sha) {
  try { return execFileSync('git', ['show', sha + ':index.html'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch { return null; }
}
const OLD = Object.fromEntries(Object.entries(RELEASES).map(([v, sha]) => [v, releaseHtml(sha)]));
const missing = Object.keys(OLD).filter(v => !OLD[v]);
if (missing.length && process.env.CI) throw new Error(`git history for release(s) ${missing.join(', ')} is missing — check out with fetch-depth: 0`);
const skip = missing.length ? `git history for ${missing.join(', ')} not available` : false;

let db, clock, open;
beforeEach(() => { db = createFirestore(); clock = 1_900_000_000_000; open = []; });
afterEach(() => open.forEach(app => app.close()));

// A device on `version` (a key of RELEASES, or 'current'), signed in to the shared cloud.
function device(version, email, saved) {
  const app = loadApp({ saved, html: version === 'current' ? undefined : OLD[version] });
  app.window.Date.now = () => (clock += 1000);
  connect(app, db, { email });
  open.push(app);
  if (version !== 'current') assert.equal(app.get('APP_VERSION'), version, 'setup: the right release loaded');
  return app;
}
function reload(app, email) {
  return device('current', email, app.window.localStorage.getItem('ranker-v1'));
}
async function cloud(app, call) {
  assert.notEqual(await app.window.eval(call), false, `${call} failed`);
}
const MOVIES = ['Heat', 'Ronin', 'Thief', 'Collateral', 'Dune'];
function seed(app) {
  app.run(`${JSON.stringify(MOVIES)}.forEach((t, k) => { const id = itemKey('Movies', t); state.items[id] = { id, cat: 'Movies', title: t, fields: { Year: String(1990 + k) }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 }; }); save();`);
}
function vote(app, w, l) {
  app.run(`(() => { const W = itemKey('Movies', ${JSON.stringify(w)}), L = itemKey('Movies', ${JSON.stringify(l)}); eloUpdate(state.items[W], state.items[L]); recordMatch('Movies', W, L); save(); })()`);
}
// Every item with its rating, in a stable order.
const rank = app => Object.values(app.get('state.items')).sort((a, b) => a.id.localeCompare(b.id))
  .map(i => `${i.title} ${i.elo} ${i.wins}-${i.losses}`);
const cloudItemDoc = (app, title) => db.peek('rankers/shared/items/' + app.get(`itemKey('Movies', ${JSON.stringify(title)})`));

describe('upgrading from 2.18.8 to the packed baseline', { skip }, () => {
  // Both devices on 2.18.8, synced, with an old-format reset in the past (ratings baked
  // into the item docs) and a vote since.
  let A, B;
  beforeEach(async () => {
    A = device('2.18.8', 'a@x'); B = device('2.18.8', 'b@x');
    seed(A);
    for (let k = 0; k < 3; k++) { vote(A, 'Heat', 'Ronin'); vote(A, 'Thief', 'Dune'); }
    await cloud(A, 'resetSharedBaseline()');
    await cloud(B, 'adoptFreshBaseline()');
    vote(B, 'Collateral', 'Heat');
    await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A), 'setup: A and B agree');
  });

  test('reloading keeps the library, and mixed versions sync both ways', async () => {
    const before = rank(A);
    A = reload(A, 'a@x');
    assert.deepEqual(rank(A), before);
    vote(A, 'Dune', 'Ronin'); await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    vote(B, 'Heat', 'Thief'); await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A));
  });

  test('a new device joining the old-format cloud gets every rating', async () => {
    const C = device('current', 'c@x');
    await cloud(C, 'pullFromFirestore()');
    assert.deepEqual(rank(C), rank(A));
  });

  test("the first reset after upgrading packs the baseline, removes the old item docs, and others' Pull adopts it", async () => {
    A = reload(A, 'a@x'); B = reload(B, 'b@x');
    const C = device('current', 'c@x'); await cloud(C, 'pullFromFirestore()');
    vote(B, 'Ronin', 'Collateral'); // unsent on B when A resets: dropped when B adopts
    await cloud(A, 'resetSharedBaseline()');
    assert.ok(db.peek('rankers/shared').baselineChunks >= 1);
    assert.equal(cloudItemDoc(A, 'Heat'), undefined, 'legacy item docs left behind');
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A));
    await cloud(C, 'pullFromFirestore()');
    assert.deepEqual(rank(C), rank(A));
  });

  test('a 2.18.8 tab after a packed reset sees an empty library, and is fine once reloaded', async () => {
    // Known and accepted: 2.18.8 can't read the packed baseline. It sees nothing rather
    // than anything wrong.
    A = reload(A, 'a@x');
    await cloud(A, 'resetSharedBaseline()');
    const D = device('2.18.8', 'd@x');
    await cloud(D, 'pullFromFirestore()');
    assert.deepEqual(rank(D), []);
    const Dn = reload(D, 'd@x');
    await cloud(Dn, 'pullFromFirestore()');
    assert.deepEqual(rank(Dn), rank(A));
  });

  test("a 2.18.8 tab's Reset after a packed one leaves a cloud the current code reads and adopts", async () => {
    // A tab left open on 2.18.8 resetting is the same as resetting from a stale device: its
    // own library wins, but nothing breaks.
    const G = device('2.18.8', 'g@x'); await cloud(G, 'adoptFreshBaseline()');
    A = reload(A, 'a@x');
    vote(A, 'Dune', 'Heat');
    await cloud(A, 'resetSharedBaseline()');
    await cloud(G, 'resetSharedBaseline()');
    const F = device('current', 'f@x');
    await cloud(F, 'pullFromFirestore()');
    assert.deepEqual(rank(F), rank(G));
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rank(A), rank(G));
  });
});

describe('upgrading from 2.19.0', { skip }, () => {
  let A, B;
  beforeEach(async () => {
    A = device('2.19.0', 'a@x'); B = device('2.19.0', 'b@x');
    seed(A);
    for (let k = 0; k < 2; k++) vote(A, 'Heat', 'Ronin');
    await cloud(A, 'resetSharedBaseline()');
    await cloud(B, 'pullFromFirestore()');
    vote(B, 'Thief', 'Dune'); await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A), 'setup: A and B agree');
  });

  test('mixed versions sync both ways, and a reset on either side is adopted by the other', async () => {
    A = reload(A, 'a@x');
    vote(A, 'Dune', 'Ronin'); await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    vote(B, 'Heat', 'Collateral'); await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A));
    await cloud(A, 'resetSharedBaseline()');
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(rank(B), rank(A), 'the 2.19.0 device adopts a current reset');
    await cloud(B, 'resetSharedBaseline()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rank(A), rank(B), 'the current device adopts a 2.19.0 reset');
  });

  test("an identity change made through the reset reaches a device still on 2.19.0", async () => {
    A = reload(A, 'a@x');
    const doc = A.window.document;
    A.run(`document.getElementById('sel-cat').value = 'Movies'; openSchemaEditor();`);
    [...doc.querySelectorAll('#schema-fields .field-row')].find(r => r.querySelector('.field-name').textContent === 'Year')
      .querySelector('[data-action="toggleIdentity"]').click();
    await A.window.eval('saveSchema()');
    assert.equal(A.get("state.schema.Movies.fields.find(f => f.name === 'Year').identity"), true, 'setup: the change saved');
    await cloud(B, 'pullFromFirestore()');
    assert.equal(B.get("state.schema.Movies.fields.find(f => f.name === 'Year').identity"), true);
    assert.deepEqual(rank(B), rank(A));
    assert.deepEqual(Object.keys(B.get('state.items')).sort(), Object.keys(A.get('state.items')).sort());
  });
});

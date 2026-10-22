// Provisional K: an item with few matches gets a bigger rating swing, so a new item moves
// toward its level in fewer comparisons. K comes from each side's OWN match count before
// the match: 96 at 0 matches, easing linearly to 32 at 24 and staying there. A settled
// item playing a new one still moves by its own K of 32.
//
// Sync: every device rebuilds ratings by applying matches as deltas, and the match counts
// it sees then aren't the voter's — so the K each side used is stored on the match record
// (kw/kl) and travels with it (matchLog, Firestore match docs, exports). A match without
// kw/kl (all history before this) is applied with 32, as before.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect } = require('./helpers/firestore');

const apps = [];
afterEach(() => apps.splice(0).forEach(a => a.close()));
function open() { const a = loadApp(); apps.push(a); return a; }

// --- helpers -------------------------------------------------------------------

// Category 'T' with items given as { title, elo = 1000, games = 0 } (games split into
// wins/losses), selected on the Rank tab.
function seed(app, items, deviceId = 'dA') {
  const s = app.get('freshState()');
  s.settings.deviceId = deviceId;
  s.cats.push('T');
  s.schema.T = { primary: 'Name', fields: [] };
  for (const { title, elo = 1000, games = 0 } of items) {
    const id = app.call('itemKey', 'T', title);
    s.items[id] = { id, cat: 'T', title, fields: {}, elo, wins: Math.ceil(games / 2), losses: Math.floor(games / 2), hidden: false, updatedAt: 1 };
  }
  app.setState(s);
  app.run(`rebuildCatSelects(); switchTab('rank'); document.getElementById('rank-cat').value = 'T';`);
}
const id = (app, title) => app.call('itemKey', 'T', title);
const item = (app, title) => app.get(`state.items[${JSON.stringify(id(app, title))}]`);
const elo = (app, title) => item(app, title).elo;
// A 1v1 vote through the real vote() the cards call.
const vote = (app, w, l) => app.run(`vote(${JSON.stringify(id(app, w))}, ${JSON.stringify(id(app, l))})`);
const lastMatch = app => app.get('state.matchLog.at(-1)');
const ratings = app => Object.fromEntries(Object.values(app.get('state.items')).map(i => [i.title, [i.elo, i.wins, i.losses]]));

// --- the swing -------------------------------------------------------------------

describe('rating swing by match count', () => {
  test('two new items: each moves by 48 (K 96), not 16', () => {
    const A = open(); seed(A, [{ title: 'N1' }, { title: 'N2' }]);
    vote(A, 'N1', 'N2');
    assert.deepEqual([elo(A, 'N1'), elo(A, 'N2')], [1048, 952]);
  });

  test('a new item against a settled one: the new item moves by 48, the settled one by 16', () => {
    const A = open(); seed(A, [{ title: 'New' }, { title: 'Old', games: 30 }]);
    vote(A, 'New', 'Old');
    assert.deepEqual([elo(A, 'New'), elo(A, 'Old')], [1048, 984]);
  });

  test('K eases with matches played: 64 at 12, 32 from 24 on', () => {
    const A = open(); seed(A, [{ title: 'Half', games: 12 }, { title: 'Done', games: 24 }, { title: 'Old', games: 40 }, { title: 'Old2', games: 40 }]);
    vote(A, 'Half', 'Old');
    assert.equal(elo(A, 'Half'), 1032, 'K 64 at 12 matches');
    vote(A, 'Done', 'Old2');
    assert.equal(elo(A, 'Done'), 1016, 'K 32 at 24 matches');
  });

  test('the match record stores the K each side used', () => {
    const A = open(); seed(A, [{ title: 'New' }, { title: 'Old', games: 30 }]);
    vote(A, 'New', 'Old');
    const m = lastMatch(A);
    assert.deepEqual([m.kw, m.kl], [96, 32]);
  });

  test('Podium: each pairwise update uses each side\'s match count at that point, and records it', () => {
    const A = open(); seed(A, [{ title: 'P1' }, { title: 'P2' }, { title: 'P3' }]);
    const [p1, p2, p3] = ['P1', 'P2', 'P3'].map(t => JSON.stringify(id(A, t)));
    A.run(`podiumPool = [${p1}, ${p2}, ${p3}].map(i => state.items[i]); podiumPlacements = { [${p1}]: 1, [${p2}]: 2, [${p3}]: 3 }; submitPodium();`);
    const ks = A.get('state.matchLog.map(m => [m.kw, m.kl])');
    // P1 beats P2 (both 0 matches), P1 beats P3 (P1 now 1), P2 beats P3 (both 1).
    assert.deepEqual(ks, [[96, 96], [93, 96], [93, 93]]);
    assert.ok(elo(A, 'P1') - 1000 > 80, `1st place gained ${elo(A, 'P1') - 1000} (about 32 with K 32)`);
  });

  test('Tier: each pairwise update uses each side\'s match count at that point, and records it', () => {
    const A = open(); seed(A, [{ title: 'T1' }, { title: 'T2' }, { title: 'T3' }]);
    const [t1, t2, t3] = ['T1', 'T2', 'T3'].map(t => JSON.stringify(id(A, t)));
    A.run(`tierPool = [${t1}, ${t2}, ${t3}].map(i => state.items[i]); tierPlacements = { [${t1}]: 'S', [${t2}]: 'A', [${t3}]: 'B' }; submitTier();`);
    assert.deepEqual(A.get('state.matchLog.map(m => [m.kw, m.kl])'), [[96, 96], [93, 96], [93, 93]]);
  });

  test('Undo puts both ratings back exactly', () => {
    const A = open(); seed(A, [{ title: 'New' }, { title: 'Old', games: 30 }]);
    vote(A, 'New', 'Old');
    A.run('undoRanking(state.history.length - 1)');
    assert.deepEqual([elo(A, 'New'), elo(A, 'Old')], [1000, 1000]);
    assert.equal(A.get('state.matchLog.length'), 0);
  });
});

// --- sync: every device applies the K the voter used --------------------------------

describe('other devices apply the stored K', () => {
  // B already had both items when A voted, but with different match counts than A (B's
  // own earlier votes), so computing K on receipt would give B different swings.
  function twoDevices() {
    const A = open(), B = open();
    seed(A, [{ title: 'New' }, { title: 'Old', games: 30 }], 'dA');
    seed(B, [{ title: 'New', games: 20 }, { title: 'Old', games: 30 }], 'dB');
    // Same ratings to start; only the match counts differ.
    return { A, B };
  }

  test('a Firestore pull applies the voter\'s K, and the match doc carries it', async () => {
    const { A, B } = twoDevices();
    const db = createFirestore();
    connect(A, db, { email: 'a@example.com' }); connect(B, db, { email: 'b@example.com' });
    vote(A, 'New', 'Old');
    await A.window.eval('uploadToFirestore()');
    const doc = db.peek(`rankers/shared/matches/${lastMatch(A).id}`);
    assert.deepEqual([doc.kw, doc.kl], [96, 32], 'K stored on the cloud match doc');
    await B.window.eval('pullFromFirestore()');
    assert.deepEqual([elo(B, 'New'), elo(B, 'Old')], [1048, 984], 'B applied K 96 / 32 (its own counts would give 43 / 32)');
  });

  test('a file import applies the voter\'s K', () => {
    const { A, B } = twoDevices();
    vote(A, 'New', 'Old');
    B.run(`mergeImport(migrateData(${JSON.stringify(A.get('buildExportPayload()'))}))`);
    assert.deepEqual([elo(B, 'New'), elo(B, 'Old')], [1048, 984]);
  });

  test('a file import that brings a brand-new item applies the stored K to the item B already had', () => {
    // A: New beats Mid, both with no matches (K 96 each). B only has Mid. On import, New's
    // rating is adopted from the file (it already includes the match), so only Mid's side
    // is applied — with A's K of 96, not 32. That side is computed against New's adopted,
    // post-match rating (applyNewMatches()'s documented approximation), so Mid lands at
    // 959 rather than A's 952; with K 32 it would be 986.
    const A = open(), B = open();
    seed(A, [{ title: 'New' }, { title: 'Mid' }], 'dA');
    seed(B, [{ title: 'Mid' }], 'dB');
    vote(A, 'New', 'Mid');
    B.run(`mergeImport(migrateData(${JSON.stringify(A.get('buildExportPayload()'))}))`);
    const E = 1 / (1 + 10 ** ((1000 - 1048) / 400));
    assert.deepEqual([elo(B, 'New'), elo(B, 'Mid')], [1048, Math.round(1000 - 96 * (1 - E))]);
  });

  test('a match recorded before this change (no kw/kl) is applied with K 32', () => {
    const A = open(); seed(A, [{ title: 'N1' }, { title: 'N2' }]);
    const m = { id: 'dX-1', cat: 'T', wid: id(A, 'N1'), lid: id(A, 'N2'), ts: 5, seq: 1 };
    A.run(`mergeImport({ items: {}, cats: [], schema: {}, matchLog: [${JSON.stringify(m)}], itemDeletes: [], itemUndeletes: [], catDeletes: [], catUndeletes: [] }, { cloudOrigin: true })`);
    assert.deepEqual([elo(A, 'N1'), elo(A, 'N2')], [1016, 984]);
  });

  test('both devices end with the same ratings after a run of votes on each side', async () => {
    const A = open(), B = open();
    const items = [{ title: 'New1' }, { title: 'New2' }, { title: 'Mid', games: 10 }, { title: 'Old', games: 30 }];
    seed(A, items, 'dA'); seed(B, items, 'dB');
    const db = createFirestore();
    connect(A, db, { email: 'a@example.com' }); connect(B, db, { email: 'b@example.com' });
    vote(A, 'New1', 'Old'); vote(A, 'Mid', 'New1');
    await A.window.eval('uploadToFirestore()');
    await B.window.eval('pullFromFirestore()');
    vote(B, 'New2', 'Mid'); vote(B, 'Old', 'New2');
    await B.window.eval('uploadToFirestore()');
    await A.window.eval('pullFromFirestore()');
    assert.deepEqual(ratings(B), ratings(A));
  });
});

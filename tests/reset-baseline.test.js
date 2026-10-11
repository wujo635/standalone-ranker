// Resetting the shared baseline, then carrying on: device A runs "Reset shared baseline",
// keeps ranking and editing, and uploads; device B runs "Adopt fresh baseline" afterwards.
// B must end up with exactly A's rankings. Everything runs through the app's real
// uploadToFirestore() / pullFromFirestore() / resetSharedBaseline() / adoptFreshBaseline()
// against an in-memory Firestore (tests/helpers/firestore.js).
//
// How it can go wrong: the reset stores each item's rating in its Firestore item doc and
// empties the matches collection. An adopting device starts every item from that stored
// rating and applies the post-reset matches on top. Anything after the reset that loses
// the stored rating (rewriting the item doc, or moving the item to a new id) leaves the
// adopting device starting that item from 1000 — its whole pre-reset history gone.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect } = require('./helpers/firestore');

let db, A, B;
beforeEach(async () => {
  db = createFirestore();
  A = loadApp(); B = loadApp();
  connect(A, db, { email: 'a@example.com' });
  connect(B, db, { email: 'b@example.com' });
  seed(A, 'dA');
  B.run(`state.settings.deviceId = 'dB'`);
  // Pre-reset history: Heat and Thief have won a lot, Ronin and Collateral lost a lot.
  for (let n = 0; n < 3; n++) { voteOn(A, 'Heat', 'Ronin'); voteOn(A, 'Thief', 'Collateral'); voteOn(A, 'Heat', 'Thief'); }
  await cloud(A, 'resetSharedBaseline()');
});
afterEach(() => { A.close(); B.close(); });

// --- helpers -------------------------------------------------------------------

const MOVIES = [['Heat', '1995', 'Michael Mann'], ['Ronin', '1998', 'John Frankenheimer'],
  ['Thief', '1981', 'Michael Mann'], ['Collateral', '2004', 'Michael Mann']];

function seed(app, deviceId) {
  const s = app.get('freshState()');
  s.settings.deviceId = deviceId;
  for (const [title, Year, Director] of MOVIES) {
    const id = app.call('itemKey', 'Movies', title);
    s.items[id] = { id, cat: 'Movies', title, fields: { Year, Director }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 };
  }
  app.setState(s);
}

const id = (app, title) => app.call('itemKey', 'Movies', title);
// Awaits one of the app's async cloud functions; asserts it reported success.
async function cloud(app, call) {
  const ok = await app.window.eval(call);
  if (ok !== undefined) assert.equal(ok, true, `${call} failed`);
}

// Records a vote exactly as vote() does to state (without the Rank UI).
function voteOn(app, winner, loser) {
  const w = JSON.stringify(id(app, winner)), l = JSON.stringify(id(app, loser));
  app.run(`eloUpdate(state.items[${w}], state.items[${l}]); recordMatch('Movies', ${w}, ${l});`);
}
// Edits through the real Library edit form: Library -> edit -> change values -> Save.
function edit(app, title, { newTitle, fields = {} } = {}) {
  const itemId = id(app, title);
  app.run(`document.getElementById('sel-cat').value = 'Movies'; renderLibrary(); editItem(${JSON.stringify(itemId)});`);
  const doc = app.window.document;
  if (newTitle !== undefined) doc.getElementById('edit-primary-' + itemId).value = newTitle;
  for (const [f, v] of Object.entries(fields)) doc.getElementById(`edit-field-${itemId}-${f}`).value = v;
  app.run(`saveItem(${JSON.stringify(itemId)})`);
}
const rename = (app, from, to) => edit(app, from, { newTitle: to });
function addMovie(app, title, Year) {
  app.run(`document.getElementById('sel-cat').value = 'Movies'; onLibCatChange();`);
  const doc = app.window.document;
  doc.getElementById('inp-primary').value = title;
  doc.getElementById('field-Year').value = Year;
  app.run('addItem()');
}
// A Movies CSV through the real import path; mode '1' = Bulk add, '2' = Replace.
function importMoviesCSV(app, rows, mode) {
  app.window.prompt = () => mode;
  const text = ['#category,Movies', '#primary,Title', '#field,Year', '#field,Director', 'Title,Year,Director',
    ...rows.map(r => r.join(','))].join('\n');
  app.run(`resolveCSVImport(parsePreloadCSV(${JSON.stringify(text)}))`);
}

// What a user sees of each item: identity, fields, and rating.
function rankings(app) {
  const items = Object.values(app.get('state.items'));
  return Object.fromEntries(items.sort((a, b) => a.id.localeCompare(b.id))
    .map(i => [i.id, { title: i.title, fields: i.fields, elo: i.elo, wins: i.wins, losses: i.losses }]));
}

// A uploads, then B adopts; B should match A item for item.
async function adoptAndCompare(note) {
  await cloud(A, 'uploadToFirestore()');
  await cloud(B, 'adoptFreshBaseline()');
  assert.deepEqual(rankings(B), rankings(A), note);
}

// --- tests ---------------------------------------------------------------------

describe('adopting after the reset', () => {
  test('right after the reset, the adopting device gets the stored ratings', async () => {
    await adoptAndCompare();
    assert.ok(rankings(B)[id(B, 'Heat')].elo > 1000, 'Heat kept its pre-reset rating');
  });

  test('votes made after the reset are applied on top of the stored ratings', async () => {
    voteOn(A, 'Ronin', 'Heat'); voteOn(A, 'Collateral', 'Thief');
    await adoptAndCompare();
  });

  test('an item added after the reset arrives with its post-reset votes', async () => {
    addMovie(A, 'Manhunter', '1986');
    voteOn(A, 'Manhunter', 'Ronin'); voteOn(A, 'Heat', 'Manhunter');
    await adoptAndCompare();
  });

  test('editing a field after the reset keeps the stored rating', async () => {
    edit(A, 'Heat', { fields: { Year: '1995 (rerelease)' } });
    voteOn(A, 'Ronin', 'Heat');
    await adoptAndCompare('Heat on B was 1000 + one vote, losing its pre-reset rating');
  });

  test('a CSV bulk add that changes a field keeps the stored rating', async () => {
    importMoviesCSV(A, [['Thief', '1981', 'Michael Mann (dir.)'], ['Heat', '1995', 'Michael Mann']], '1');
    await adoptAndCompare();
  });

  test('renaming after the reset keeps the stored rating', async () => {
    rename(A, 'Heat', 'Heat (1995)');
    voteOn(A, 'Ronin', 'Heat (1995)');
    await adoptAndCompare('Heat (1995) on B started from 1000');
  });

  test('renaming twice keeps the stored rating', async () => {
    rename(A, 'Heat', 'Heat (1995)');
    voteOn(A, 'Heat (1995)', 'Ronin');
    rename(A, 'Heat (1995)', 'Heat (Director’s Cut)');
    await adoptAndCompare();
  });

  test('renaming and then renaming back keeps the stored rating', async () => {
    rename(A, 'Heat', 'Heat (1995)');
    voteOn(A, 'Ronin', 'Heat (1995)');
    rename(A, 'Heat (1995)', 'Heat');
    await adoptAndCompare();
  });

  test('deleting and re-adding a title starts it fresh, as on the device that did it', async () => {
    A.run(`deleteItem(${JSON.stringify(id(A, 'Heat'))})`);
    addMovie(A, 'Heat', '1995');
    voteOn(A, 'Heat', 'Ronin');
    await adoptAndCompare();
    assert.equal(rankings(B)[id(B, 'Heat')].wins, 1, 'only the post-re-add vote');
  });

  test('a CSV Replace starts the category fresh, as on the device that did it', async () => {
    importMoviesCSV(A, MOVIES, '2');
    voteOn(A, 'Ronin', 'Heat');
    await adoptAndCompare();
    assert.equal(rankings(B)[id(B, 'Heat')].losses, 1, 'only the post-Replace vote');
  });
});

describe('a device that adopted earlier', () => {
  test('keeps up with later votes, edits, and renames through ordinary pulls', async () => {
    await cloud(B, 'adoptFreshBaseline()');
    edit(A, 'Heat', { fields: { Year: '1995 (rerelease)' } });
    rename(A, 'Thief', 'Thief (1981)');
    voteOn(A, 'Ronin', 'Heat'); voteOn(A, 'Thief (1981)', 'Collateral');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(rankings(B), rankings(A));
  });
});

describe('the packed baseline (2.19.0)', () => {
  // A reset used to write one Firestore doc per item, ratings baked in, and every device
  // adopting it read them all back: about 6,500 writes and 6,500 reads per device for the
  // real library, most of a day's free quota. It now packs the items into a few chunk docs.
  const root = () => db.peek('rankers/shared');
  const cloudPaths = prefix => db.written.filter(p => p.startsWith('rankers/shared/' + prefix));
  function addMany(app, n) {
    app.run(`for (let k = 0; k < ${n}; k++) {
      const title = 'Film ' + k, id = itemKey('Movies', title);
      state.items[id] = { id, cat: 'Movies', title, fields: { Year: String(1950 + (k % 70)), Director: 'Someone' }, elo: 1000 + (k % 50), wins: k % 7, losses: k % 5, hidden: false, updatedAt: 2 };
    }`);
  }

  test('a reset writes a chunk doc, not a doc per item', async () => {
    addMany(A, 200);
    db.written.length = 0;
    await cloud(A, 'resetSharedBaseline()');
    assert.deepEqual(cloudPaths('items/'), [], 'item docs were written');
    assert.equal(root().baselineChunks, 1);
    assert.ok(cloudPaths('baseline/0').length >= 1);
  });

  test('adopting reads a handful of docs, whatever the library size', async () => {
    addMany(A, 200);
    await cloud(A, 'resetSharedBaseline()');
    db.reads = 0;
    await cloud(B, 'adoptFreshBaseline()');
    assert.ok(db.reads <= 5, `adopting read ${db.reads} docs for 204 items`);
    assert.deepEqual(rankings(B), rankings(A));
  });

  test('a baseline split across several chunks restores every item and rating', async () => {
    addMany(A, 50);
    A.run('BASELINE_CHUNK_BYTES = 1000');
    await cloud(A, 'resetSharedBaseline()');
    assert.ok(root().baselineChunks > 3, 'expected several chunks');
    await cloud(B, 'adoptFreshBaseline()');
    assert.deepEqual(rankings(B), rankings(A));
  });

  test('a pull that finds an incomplete baseline merges nothing', async () => {
    A.run('BASELINE_CHUNK_BYTES = 200');
    await cloud(A, 'resetSharedBaseline()');
    await db.collection('rankers').doc('shared').collection('baseline').doc('1').delete();
    assert.equal(await B.window.eval('pullFromFirestore()'), false);
    assert.deepEqual(Object.keys(B.get('state.items')), []);
  });

  test('an item edited after the reset keeps its rating from the baseline and its new fields', async () => {
    edit(A, 'Heat', { fields: { Director: 'M. Mann' } });
    await adoptAndCompare();
    assert.equal(rankings(B)[id(B, 'Heat')].fields.Director, 'M. Mann');
  });

  test("Reset checks it can write the baseline before deleting anything", async () => {
    const db2 = createFirestore({ deny: ['baseline'] });
    const C = loadApp();
    try {
      connect(C, db2, { email: 'c@example.com' });
      seed(C, 'dC');
      await cloud(C, 'uploadToFirestore()');
      const before = db2.peek('rankers/shared/items/' + id(C, 'Heat'));
      await C.window.eval('resetSharedBaseline()');
      assert.deepEqual(db2.peek('rankers/shared/items/' + id(C, 'Heat')), before, 'the cloud was wiped anyway');
    } finally { C.close(); }
  });
});

describe('a device that missed a reset (2.19.0)', () => {
  // A plain Pull merged the reseed into the device's old state: its stale ratings stayed
  // (stored ratings only seed items a device lacks), and the pull then let it upload them.
  // It now adopts the reset, as "Adopt fresh baseline" does.
  beforeEach(async () => {
    await cloud(B, 'adoptFreshBaseline()');
    for (let n = 0; n < 2; n++) voteOn(A, 'Collateral', 'Heat');
    await cloud(A, 'resetSharedBaseline()');
  });

  test('a plain Pull adopts the reset; unsent votes there are not kept', async () => {
    voteOn(B, 'Ronin', 'Thief');
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(rankings(B), rankings(A));
  });

  test('items hidden on it stay hidden', async () => {
    B.run(`state.items[${JSON.stringify(id(B, 'Ronin'))}].hidden = true`);
    await cloud(B, 'pullFromFirestore()');
    assert.equal(B.get(`state.items[${JSON.stringify(id(B, 'Ronin'))}].hidden`), true);
  });

  test('Upload is refused until it pulls, then works', async () => {
    voteOn(B, 'Ronin', 'Thief');
    assert.equal(await B.window.eval('uploadToFirestore()'), false);
    await cloud(B, 'pullFromFirestore()');
    voteOn(B, 'Ronin', 'Thief');
    await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(rankings(A), rankings(B));
  });

  test('also after the first reset ever, when no device had seen a baseline', async () => {
    const db2 = createFirestore();
    const C = loadApp(), D = loadApp();
    try {
      connect(C, db2, { email: 'c@example.com' }); connect(D, db2, { email: 'd@example.com' });
      seed(C, 'dC');
      await cloud(C, 'uploadToFirestore()');
      await cloud(D, 'pullFromFirestore()');
      voteOn(C, 'Heat', 'Ronin');
      await cloud(C, 'resetSharedBaseline()');
      await cloud(D, 'pullFromFirestore()');
      assert.deepEqual(rankings(D), rankings(C));
    } finally { C.close(); D.close(); }
  });

  test('also on a device that has only ever uploaded, never pulled', async () => {
    const db2 = createFirestore();
    const C = loadApp(), D = loadApp();
    try {
      connect(C, db2, { email: 'c@example.com' }); connect(D, db2, { email: 'd@example.com' });
      seed(C, 'dC');
      await cloud(C, 'uploadToFirestore()'); // the cloud was empty, so C has never pulled anything
      await cloud(D, 'pullFromFirestore()');
      voteOn(D, 'Heat', 'Ronin');
      await cloud(D, 'resetSharedBaseline()');
      voteOn(C, 'Thief', 'Collateral'); // unsent: lost when C adopts
      await cloud(C, 'pullFromFirestore()');
      assert.deepEqual(rankings(C), rankings(D));
    } finally { C.close(); D.close(); }
  });

  test('a device that has never synced merges its own library instead of clearing it', async () => {
    const C = loadApp();
    try {
      connect(C, db, { email: 'c@example.com' });
      const s = C.get('freshState()');
      const own = C.call('itemKey', 'Movies', 'Manhunter');
      s.items[own] = { id: own, cat: 'Movies', title: 'Manhunter', fields: { Year: '1986' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 5 };
      C.setState(s);
      await cloud(C, 'pullFromFirestore()');
      assert.ok(C.get(`!!state.items[${JSON.stringify(own)}]`), 'its own item was cleared');
      assert.ok(C.get(`!!state.items[${JSON.stringify(id(C, 'Heat'))}]`), 'the cloud items arrived');
    } finally { C.close(); }
  });
});

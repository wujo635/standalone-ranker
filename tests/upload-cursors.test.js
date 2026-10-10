// What Upload sends after a device fills an empty library from the cloud. Upload sends
// whatever is newer than this device's upload cursors (settings.lastUploaded*). A device
// that pulls into an empty library — "Adopt fresh baseline", or a brand-new device's
// first pull — has every cursor at 0, so without care its next Upload re-sends every
// item and tombstone it just pulled: harmless identical rewrites, but one write per doc,
// and every other device then re-reads them all on its next pull. Runs the real
// upload/pull/adopt code against the in-memory Firestore (tests/helpers/firestore.js),
// which records every path written.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect } = require('./helpers/firestore');

let db, A;
const others = [];
beforeEach(async () => {
  db = createFirestore();
  A = loadApp();
  connect(A, db, { email: 'a@example.com' });
  seed(A);
  await cloud(A, 'uploadToFirestore()');
  await cloud(A, 'pullFromFirestore()');
  assert.deepEqual(await uploaded(A), [], 'setup: A is in sync');
});
afterEach(() => { [A, ...others.splice(0)].forEach(app => app.close()); });

// --- helpers -------------------------------------------------------------------

const SONGS = ['Creep', 'Lucky', 'Reckoner', 'Nude', 'Airbag'];

// Five songs, three comparisons, and one of each kind of tombstone/undelete, so every
// upload cursor has something to cover.
function seed(app) {
  app.run(`
    ${JSON.stringify(SONGS)}.forEach((title, n) => {
      const id = itemKey('Songs', title, identitySuffixFor('Songs', { Artist: 'Radiohead' }));
      state.items[id] = { id, cat: 'Songs', title, fields: { Artist: 'Radiohead' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 100 + n };
    });
    const ids = Object.keys(state.items);
    for (let n = 0; n < 3; n++) { eloUpdate(state.items[ids[0]], state.items[ids[1]]); recordMatch('Songs', ids[0], ids[1]); }
    const dev = state.settings.deviceId;
    state.itemDeletes.push({ itemId: 'igone', ts: 50, deviceId: dev, title: 'Gone', cat: 'Songs' });
    state.itemDeletes.push({ itemId: 'iback', ts: 60, deviceId: dev, title: 'Back', cat: 'Songs' });
    state.itemUndeletes.push({ itemId: 'iback', ts: 70, deviceId: dev, title: 'Back', cat: 'Songs' });
    state.catDeletes.push({ cat: 'Podcasts', ts: 80, deviceId: dev });
    state.catDeletes.push({ cat: 'Albums', ts: 81, deviceId: dev });
    state.catUndeletes.push({ cat: 'Albums', ts: 90, deviceId: dev });
  `);
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
// Runs an Upload and returns the docs it wrote (sorted, relative to rankers/shared),
// leaving out the root doc, which every Upload rewrites (cats/schema).
async function uploaded(app) {
  db.written.length = 0;
  await cloud(app, 'uploadToFirestore()');
  return db.written.filter(p => p !== 'rankers/shared').map(p => p.replace('rankers/shared/', '')).sort();
}
const id = (app, title) => app.get(`itemKey('Songs', ${JSON.stringify(title)}, identitySuffixFor('Songs', { Artist: 'Radiohead' }))`);
function addSong(app, title) {
  app.run(`document.getElementById('sel-cat').value = 'Songs'; onLibCatChange();`);
  const doc = app.window.document;
  doc.getElementById('inp-primary').value = title;
  doc.getElementById('field-Artist').value = 'Radiohead';
  app.run('addItem()');
}
function rename(app, from, to) {
  const itemId = id(app, from);
  app.run(`document.getElementById('sel-cat').value = 'Songs'; renderLibrary(); editItem(${JSON.stringify(itemId)});`);
  app.window.document.getElementById('edit-primary-' + itemId).value = to;
  app.run(`saveItem(${JSON.stringify(itemId)})`);
}
function voteOn(app, winner, loser) {
  const w = JSON.stringify(id(app, winner)), l = JSON.stringify(id(app, loser));
  app.run(`eloUpdate(state.items[${w}], state.items[${l}]); recordMatch('Songs', ${w}, ${l});`);
}

// --- tests ---------------------------------------------------------------------

describe('Upload after filling an empty library from the cloud', () => {
  test('after "Adopt fresh baseline", Upload re-sends nothing', async () => {
    addSong(A, 'Unwanted');
    await cloud(A, 'adoptFreshBaseline()');
    assert.equal(A.get('Object.keys(state.items).length'), SONGS.length, 'setup: the unwanted song is gone');
    assert.deepEqual(await uploaded(A), [], 'every item and tombstone was re-sent');
  });

  test("after a brand-new device's first pull, Upload re-sends nothing", async () => {
    const C = newDevice();
    await cloud(C, 'pullFromFirestore()');
    assert.equal(C.get('Object.keys(state.items).length'), SONGS.length, 'setup: C has the library');
    assert.deepEqual(await uploaded(C), []);
  });

  test('after adopting a reset baseline, Upload re-sends nothing', async () => {
    await cloud(A, 'resetSharedBaseline()');
    const C = newDevice();
    await cloud(C, 'adoptFreshBaseline()');
    assert.deepEqual(await uploaded(C), []);
  });

  test('work done after adopting still uploads — exactly that work', async () => {
    await cloud(A, 'adoptFreshBaseline()');
    const before = { lucky: id(A, 'Lucky'), nude: id(A, 'Nude') };
    addSong(A, 'Let Down');
    A.run(`deleteItem(${JSON.stringify(before.nude)})`);
    rename(A, 'Lucky', 'Lucky (Live)');
    voteOn(A, 'Let Down', 'Creep');
    const dev = A.get('state.settings.deviceId');
    assert.deepEqual(await uploaded(A), [
      `itemDeletes/${before.lucky}`, `itemDeletes/${before.nude}`,
      `items/${id(A, 'Let Down')}`, `items/${id(A, 'Lucky (Live)')}`,
      `matches/${dev}-1`,
    ].sort());
  });

  test('a device with its own unsent work that pulls still uploads that work', async () => {
    const B = newDevice();
    addSong(B, 'Let Down');
    await cloud(B, 'pullFromFirestore()');
    const sent = await uploaded(B);
    assert.ok(sent.includes(`items/${id(B, 'Let Down')}`), 'its own new song was sent');
  });
});

describe('Upload sends only what the cloud does not have (2.18.7)', () => {
  // Upload used to send every item newer than its cursor, including items it had only
  // pulled. Usually an identical rewrite — but a device that was behind sent its older
  // copy over a newer one, and devices never agreed again. It also pushed an older edit
  // over a newer one uploaded in between. Upload now pulls first and skips items whose
  // version is the cloud's (cloudUpdatedAt).
  let B, now = 1_900_000_000_000;
  const clock = app => { app.window.Date.now = () => now; };
  beforeEach(async () => {
    B = newDevice();
    [A, B].forEach(clock);
    await cloud(B, 'pullFromFirestore()');
  });
  const album = (app, title) => app.get(`state.items[${JSON.stringify(id(app, title))}].fields.Album`);
  function editAlbum(app, title, value) {
    now += 1000;
    const itemId = id(app, title);
    app.run(`document.getElementById('sel-cat').value = 'Songs'; renderLibrary(); editItem(${JSON.stringify(itemId)});`);
    app.window.document.getElementById(`edit-field-${itemId}-Album`).value = value;
    app.run(`saveItem(${JSON.stringify(itemId)})`);
  }
  const cloudAlbum = title => db.peek('rankers/shared/items/' + id(A, title))?.fields?.Album;

  test('items this device only pulled are not sent back', async () => {
    editAlbum(A, 'Creep', 'Pablo Honey');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(await uploaded(B), []);
  });

  test("a device that is behind doesn't overwrite a newer copy with the one it pulled", async () => {
    // B pulls one edit (into a library that isn't empty, so its cursors stay put)...
    editAlbum(A, 'Creep', 'Pablo Honey (first edit)');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'pullFromFirestore()');
    // ...misses the next one, and uploads.
    editAlbum(A, 'Creep', 'Pablo Honey');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'uploadToFirestore()');
    assert.equal(cloudAlbum('Creep'), 'Pablo Honey', 'B sent back the copy it pulled');
    const C = newDevice();
    await cloud(C, 'pullFromFirestore()');
    assert.equal(album(C, 'Creep'), 'Pablo Honey');
  });

  test('of two edits to the same item, the newer wins everywhere, whichever uploads last', async () => {
    editAlbum(B, 'Creep', 'Old edit');
    editAlbum(A, 'Creep', 'New edit');
    await cloud(A, 'uploadToFirestore()');
    await cloud(B, 'uploadToFirestore()');
    assert.equal(cloudAlbum('Creep'), 'New edit', "B's older edit replaced the newer one in the cloud");
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual([album(A, 'Creep'), album(B, 'Creep')], ['New edit', 'New edit']);
  });

  test("this device's own edits still upload after the pull", async () => {
    editAlbum(B, 'Lucky', 'OK Computer');
    assert.deepEqual(await uploaded(B), [`items/${id(B, 'Lucky')}`]);
  });
});

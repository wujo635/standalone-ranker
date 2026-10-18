// Where the library is saved (2.25.0): one IndexedDB record holding the JSON string that
// used to go in localStorage, moved over on first load, with localStorage kept only for a
// browser where IndexedDB has never worked. Runs against fake-indexeddb; every other
// test file runs the localStorage path (jsdom has no IndexedDB).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { loadApp } = require('./helpers/app');
const { createFirestore, connect, fakeFirebase } = require('./helpers/firestore');

// The app's own names (IDB_NAME / IDB_STORE / IDB_KEY / STORAGE_MARKER_KEY in index.html).
const DB = 'ranker', STORE = 'kv', KEY = 'ranker-v1', MARKER = 'ranker-storage';

const open = [];
afterEach(() => open.splice(0).forEach(app => app.close()));
function page(opts) { const app = loadApp(opts); open.push(app); return app; }

const waitFor = async (pred, what) => {
  for (let n = 0; n < 200 && !(await pred()); n++) await new Promise(r => setTimeout(r, 5));
  assert.ok(await pred(), 'timed out waiting for ' + what);
};

// Reads/writes the stored record directly, as another tab would.
function withStore(factory, mode, op) {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction(STORE, mode), r = op(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(r.result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
const readRecord = factory => withStore(factory, 'readonly', s => s.get(KEY));
const writeRecord = (factory, value) => withStore(factory, 'readwrite', s => s.put(value, KEY));

// An IndexedDB whose open() always fails, like Firefox on file:// or a broken profile.
const brokenIdb = () => ({
  open() {
    const req = {};
    setTimeout(() => { req.error = Object.assign(new Error('open failed'), { name: 'UnknownError' }); req.onerror?.(); }, 0);
    return req;
  },
});

function addItem(app, title) {
  app.run(`(() => { const id = itemKey('Movies', ${JSON.stringify(title)}); state.items[id] = { id, cat: 'Movies', title: ${JSON.stringify(title)}, fields: { Year: '', Director: '' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: Date.now() }; save(); })()`);
}
const titles = app => Object.values(app.get('state.items')).map(i => i.title).sort();
// A saved library (the localStorage string a pre-2.25.0 browser holds) with these titles.
function savedLibrary(...list) {
  const src = page();
  list.forEach(t => addItem(src, t));
  return src.window.localStorage.getItem(KEY);
}
const banner = app => app.window.document.getElementById('save-warning').textContent;

describe('IndexedDB storage (2.25.0)', () => {
  test('a library in localStorage moves to IndexedDB on first load, and the localStorage copy goes', async () => {
    const idb = new IDBFactory();
    const app = page({ saved: savedLibrary('Heat', 'Ronin'), idb });
    await app.ready();
    assert.deepEqual(titles(app), ['Heat', 'Ronin']);
    await waitFor(() => app.localStorage()[MARKER] === 'idb', 'the marker');
    assert.equal(app.localStorage()[KEY], undefined, 'localStorage copy removed');
    assert.deepEqual(Object.values(JSON.parse(await readRecord(idb)).items).map(i => i.title).sort(), ['Heat', 'Ronin']);
    // Reload in the same browser: read from IndexedDB.
    const again = page({ idb, storage: app.localStorage() });
    await again.ready();
    assert.deepEqual(titles(again), ['Heat', 'Ronin']);
    assert.equal(again.get('!!idb'), true);
  });

  test('saves go to IndexedDB and survive a reload', async () => {
    const idb = new IDBFactory();
    const app = page({ idb });
    await app.ready();
    addItem(app, 'Thief');
    await waitFor(() => app.localStorage()[MARKER] === 'idb', 'the first save');
    const again = page({ idb, storage: app.localStorage() });
    await again.ready();
    assert.deepEqual(titles(again), ['Thief']);
    assert.equal(again.localStorage()[KEY], undefined, 'nothing written to localStorage');
  });

  test('once moved, an IndexedDB that fails to open pauses saving instead of starting empty', async () => {
    const app = page({ idb: brokenIdb(), storage: { [MARKER]: 'idb', [KEY]: savedLibrary('Old copy') } });
    await app.ready();
    assert.equal(app.get('loadFailed.storage'), true);
    assert.deepEqual(titles(app), [], 'the stale localStorage copy is not loaded');
    assert.match(banner(app), /couldn't open its saved data/);
    addItem(app, 'Heat');
    assert.deepEqual(Object.values(JSON.parse(app.localStorage()[KEY]).items).map(i => i.title), ['Old copy'], 'nothing written');
    app.run('clearAllDataCore(); save()');
    assert.equal(app.get('loadFailed.storage'), true, 'Clear all data does not resume saving');
    assert.equal(app.localStorage()[KEY], undefined, 'nothing written after it either');
  });

  test('a browser where IndexedDB never worked keeps using localStorage', async () => {
    const app = page({ idb: brokenIdb(), saved: savedLibrary('Heat') });
    await app.ready();
    assert.equal(app.get('loadFailed'), null);
    assert.deepEqual(titles(app), ['Heat']);
    addItem(app, 'Ronin');
    assert.deepEqual(Object.values(JSON.parse(app.localStorage()[KEY]).items).map(i => i.title).sort(), ['Heat', 'Ronin']);
    assert.equal(app.localStorage()[MARKER], undefined);
    assert.match(app.window.document.getElementById('version-info').textContent, /localStorage \(IndexedDB unavailable/);
  });

  test('an unreadable IndexedDB record pauses saving and is left untouched', async () => {
    const idb = new IDBFactory();
    await writeRecord(idb, '{not json');
    const app = page({ idb, storage: { [MARKER]: 'idb' } });
    await app.ready();
    assert.equal(app.get('loadFailed.raw'), '{not json', 'offered for download');
    addItem(app, 'Heat');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(await readRecord(idb), '{not json');
  });

  test('a save before the library has loaded writes nothing', async () => {
    // Worst case, mid-move: load() reads localStorage only after IndexedDB answers, so an
    // early save of the empty startup state would replace the library it is about to move.
    const idb = new IDBFactory();
    const app = page({ idb, saved: savedLibrary('Heat') });
    assert.equal(app.get('appLoaded'), false, 'still loading');
    app.run('save()');
    await app.ready();
    assert.deepEqual(titles(app), ['Heat']);
    await waitFor(() => app.localStorage()[MARKER] === 'idb', 'the move');
    assert.deepEqual(Object.values(JSON.parse(await readRecord(idb)).items).map(i => i.title), ['Heat']);
  });

  test('Clear all data empties IndexedDB', async () => {
    const idb = new IDBFactory();
    await writeRecord(idb, savedLibrary('Heat'));
    const app = page({ idb, storage: { [MARKER]: 'idb' } });
    await app.ready();
    app.run('clearAllDataCore()');
    await waitFor(async () => (await readRecord(idb)) === undefined, 'the delete');
    const again = page({ idb, storage: app.localStorage() });
    await again.ready();
    assert.deepEqual(titles(again), []);
    assert.equal(again.get('loadFailed'), null, 'a missing record is an empty library, not an error');
  });

  test('the startup cloud pull waits for the library to load from IndexedDB', async () => {
    // Without the wait, a restored sign-in ran syncOnLoad() on the empty startup state,
    // which looks like a device that never synced, so it skipped the pull.
    const db = createFirestore();
    const A = page(); connect(A, db, { email: 'a@example.com' });
    addItem(A, 'Heat'); addItem(A, 'Ronin');
    assert.notEqual(await A.window.eval('uploadToFirestore()'), false);
    const B = page(); connect(B, db, { email: 'b@example.com' });
    assert.notEqual(await B.window.eval('pullFromFirestore()'), false);
    addItem(A, 'Thief');
    assert.notEqual(await A.window.eval('uploadToFirestore()'), false);

    const idb = new IDBFactory();
    await writeRecord(idb, B.window.localStorage.getItem(KEY));
    const fb = fakeFirebase(db);
    const B2 = page({ idb, storage: { [MARKER]: 'idb' }, beforeScript: fb.install });
    fb.signIn('b@example.com'); // the session restores before IndexedDB has answered
    await waitFor(() => B2.window.document.getElementById('toast').textContent.startsWith('Synced'), 'the sync toast');
    assert.equal(B2.window.document.getElementById('toast').textContent, 'Synced with the cloud — pulled 1 item');
    assert.deepEqual(titles(B2), ['Heat', 'Ronin', 'Thief']);
  });
});

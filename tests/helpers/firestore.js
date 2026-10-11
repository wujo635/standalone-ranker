// In-memory stand-in for the slice of the Firestore compat SDK the app uses, so the
// real uploadToFirestore() / pullFromFirestore() / resetSharedBaseline() /
// adoptFreshBaseline() can run end to end between several loadApp() pages sharing one
// "cloud". Behaviour that matters to the app is modelled the way Firestore does it:
//
//   - set(data) with no options REPLACES the whole document; { merge: true } deep-merges
//     maps; { mergeFields: [...] } replaces only the listed top-level fields.
//   - serverTimestamp() resolves at commit time; every commit gets a later time than the
//     one before, so `where('syncedAt', '>', cursor)` behaves like the real thing.
//   - Deleting a document doesn't delete its subcollections.
//   - An `undefined` field value is rejected, as the real SDK does.
//   - Reads are billed per document returned, as Firestore does: db.reads counts them (a
//     doc get() is one; a collection get() is one per doc it returns).
//   - createFirestore({ deny: ['baseline'] }) rejects writes to paths containing any of
//     those segments with a permission-denied error, like a missing security rule.
//
// Usage: const db = createFirestore(); connect(app, db); then call the app's own cloud
// functions with `await app.window.eval('uploadToFirestore()')`.

class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
}
const SERVER_TIMESTAMP = Object.freeze({ serverTimestamp: true });

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp);

// Copies a value into this (Node) realm, resolving server timestamps.
function resolve(v, now, path = '') {
  if (v === undefined) throw new Error(`Unsupported field value: undefined (found in field ${path})`);
  if (v === SERVER_TIMESTAMP) return new Timestamp(now);
  if (v instanceof Timestamp) return v;
  if (Array.isArray(v)) return v.map((x, i) => resolve(x, now, `${path}[${i}]`));
  if (isMap(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = resolve(v[k], now, path ? `${path}.${k}` : k);
    return out;
  }
  return v;
}
function deepMerge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = isMap(patch[k]) && isMap(base[k]) ? deepMerge(base[k], patch[k]) : patch[k];
  return out;
}
const copy = v => (isMap(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : Array.isArray(v) ? v.map(copy) : v);

function createFirestore({ deny = [] } = {}) {
  const docs = new Map(); // full path -> data
  const written = []; // every path set(), in order — see db.written
  const counts = { reads: 0 };
  let clock = 1_000_000;

  function checkAllowed(path) {
    if (deny.some(seg => path.split('/').includes(seg))) {
      const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
    }
  }
  function write(path, data, opts, now) {
    checkAllowed(path);
    const resolved = resolve(data, now);
    written.push(path);
    const existing = docs.get(path);
    if (opts && opts.mergeFields) {
      const out = { ...(existing || {}) };
      opts.mergeFields.forEach(f => { if (f in resolved) out[f] = resolved[f]; });
      docs.set(path, out);
    } else if (opts && opts.merge) {
      docs.set(path, deepMerge(existing || {}, resolved));
    } else {
      docs.set(path, resolved);
    }
  }
  function snapshot(path) {
    const d = docs.get(path);
    return { id: path.split('/').pop(), exists: d !== undefined, ref: docRef(path), data: () => (d === undefined ? undefined : copy(d)) };
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      collection: name => collectionRef(`${path}/${name}`),
      get: async () => { counts.reads++; return snapshot(path); },
      set: async (data, opts) => write(path, data, opts, ++clock),
      delete: async () => { docs.delete(path); },
    };
  }
  function matches(data, [field, op, value]) {
    if (op !== '>') throw new Error('fake Firestore only supports ">" queries');
    const v = data[field];
    if (v === undefined) return false; // Firestore leaves out docs missing the field
    return (v instanceof Timestamp ? v.toMillis() : v) > (value instanceof Timestamp ? value.toMillis() : value);
  }
  function collectionRef(path, filters = []) {
    return {
      path,
      doc: id => docRef(`${path}/${id}`),
      where: (field, op, value) => collectionRef(path, [...filters, [field, op, value]]),
      get: async () => {
        const prefix = path + '/';
        const found = [...docs.keys()]
          .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .filter(k => filters.every(f => matches(docs.get(k), f)))
          .map(snapshot);
        counts.reads += found.length;
        return { docs: found, size: found.length, empty: !found.length, forEach: fn => found.forEach(fn) };
      },
    };
  }

  return {
    collection: name => collectionRef(name),
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push({ check: () => checkAllowed(ref.path), run: now => write(ref.path, data, opts, now) }); },
        delete(ref) { ops.push({ run: () => docs.delete(ref.path) }); },
        async commit() {
          const now = ++clock;
          // All or nothing, like a real batch: a denied write fails the whole commit.
          ops.forEach(op => op.check && op.check());
          ops.forEach(op => op.run(now));
        },
      };
    },
    // Test-side inspection: the stored data of one document, or undefined.
    // Paths written so far (one entry per set(), repeats included). Tests clear it with
    // db.written.length = 0 before the step they want to measure.
    written,
    get reads() { return counts.reads; },
    set reads(n) { counts.reads = n; },
    peek: path => (docs.has(path) ? copy(docs.get(path)) : undefined),
  };
}

// Points a loadApp() page at `db`, signed in, with the browser-only bits a reset or
// adopt touches (confirm dialogs, file downloads) stubbed out.
function connect(app, db, { email = 'user@example.com' } = {}) {
  app.window.firebase = { firestore: { FieldValue: { serverTimestamp: () => SERVER_TIMESTAMP }, Timestamp } };
  app.window.__fakeDb = db;
  app.window.confirm = () => true;
  app.run(`cloudDb = window.__fakeDb; cloudAvailable = true; cloudUser = { uid: ${JSON.stringify(email)}, email: ${JSON.stringify(email)} }; downloadJson = () => {};`);
}

// A stand-in for the global `firebase` the CDN scripts define, so the app's own startup
// runs: initializeApp(), firebase.firestore() (returning `db`) and onAuthStateChanged().
// Install it before the script runs — loadApp({ beforeScript: fb.install }) — then
// fb.signIn(email) fires the auth callback the way a restored session does after load.
function fakeFirebase(db) {
  let authCallback = null, win = null;
  return {
    install(window) {
      win = window;
      window.firebase = {
        initializeApp() {},
        auth: () => ({ onAuthStateChanged: cb => { authCallback = cb; } }),
        firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => SERVER_TIMESTAMP }, Timestamp }),
      };
      window.confirm = () => true;
    },
    signIn(email = 'user@example.com') {
      win.eval('downloadJson = () => {}');
      authCallback({ uid: email, email });
    },
  };
}

module.exports = { createFirestore, connect, fakeFirebase };

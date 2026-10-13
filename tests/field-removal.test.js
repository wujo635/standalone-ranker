// Removing a field from a category that's already synced (2.22.0). The cloud's field list
// is merged in additively (cloudSchemaUnion()/unionItemsAndSchema()), so before 2.22.0 a
// field removed in the Schema Editor came straight back on the next Pull. Real report: an
// empty Songs "Year" field kept returning after it was deleted. Now a synced device removes
// a field through a reset of the shared baseline, like changing an identity field (2.20.0).
// Runs the real Schema Editor and upload/pull/reset code against the in-memory Firestore.
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
  A.run(`const i = Object.values(state.items); eloUpdate(i[0], i[1]); recordMatch('Movies', i[0].id, i[1].id);`);
  await cloud(A, 'uploadToFirestore()');
  await cloud(B, 'pullFromFirestore()');
  assert.deepEqual(fieldNames(B), ['Year', 'Director'], 'setup: B has both fields');
  A.run('window.__toasts = []; const __toast = toast; toast = m => { window.__toasts.push(m); __toast(m); };');
});
afterEach(() => { [A, B, ...others.splice(0)].forEach(app => app.close()); });

// --- helpers -------------------------------------------------------------------

function seed(app, deviceId) {
  const s = app.get('freshState()');
  s.settings.deviceId = deviceId;
  for (const [title, Year, Director] of [['Heat', '1995', 'Michael Mann'], ['Ronin', '1998', 'John Frankenheimer']]) {
    const id = app.call('itemKey', 'Movies', title);
    s.items[id] = { id, cat: 'Movies', title, fields: { Year, Director }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 };
  }
  app.setState(s);
}
async function cloud(app, call) {
  const ok = await app.window.eval(call);
  if (ok !== undefined) assert.equal(ok, true, `${call} failed`);
}
const fieldNames = (app, cat = 'Movies') => app.get(`state.schema[${JSON.stringify(cat)}].fields.map(f => f.name)`);
// JSON round-trip: peek() returns the page realm's objects, which deepStrictEqual rejects.
const cloudFieldNames = (cat = 'Movies') => JSON.parse(JSON.stringify((db.peek('rankers/shared')?.schema?.[cat]?.fields || []).map(f => f.name)));
const baselineId = () => db.peek('rankers/shared')?.baselineId;
const toasts = () => A.get('window.__toasts').join('\n');
const ratings = app => Object.values(app.get('state.items')).map(i => [i.title, i.elo, i.wins, i.losses]).sort();

// Library -> "Fields" -> ✕ on the field -> Save, through the real Schema Editor controls.
// Resolves once the save, and the reset it may start, is done.
async function removeFieldInEditor(app, name, cat = 'Movies') {
  const doc = app.window.document;
  app.run(`document.getElementById('sel-cat').value = ${JSON.stringify(cat)}; openSchemaEditor();`);
  const row = [...doc.querySelectorAll('#schema-fields .field-row')].find(r => r.querySelector('.field-name').textContent === name);
  row.querySelector('[data-action="removeEditingField"]').click();
  await app.window.eval('saveSchema()');
}

// --- tests ---------------------------------------------------------------------

describe('removing a field on a synced device', () => {
  test('stays removed on every device through later syncs', async () => {
    const before = ratings(A);
    await removeFieldInEditor(A, 'Director');
    assert.deepEqual(fieldNames(A), ['Year']);
    assert.deepEqual(cloudFieldNames(), ['Year'], 'the cloud kept the field');
    // The bug: the next Pull merged the cloud's (or another device's) field list back in.
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(fieldNames(A), ['Year'], 'the field came back on A after a Pull');
    await cloud(B, 'pullFromFirestore()');
    assert.deepEqual(fieldNames(B), ['Year'], 'B kept the field');
    await cloud(B, 'uploadToFirestore()');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(fieldNames(A), ['Year'], "B's upload brought the field back");
    assert.deepEqual(cloudFieldNames(), ['Year']);
    assert.deepEqual(ratings(A), before, 'ratings changed');
    assert.deepEqual(ratings(B), before);
  });

  test('resets the shared baseline', async () => {
    const before = baselineId();
    await removeFieldInEditor(A, 'Director');
    assert.ok(baselineId() && baselineId() !== before, 'no reset ran');
    assert.match(toasts(), /shared baseline reset/);
  });

  test('also in a category without items', async () => {
    A.run(`state.cats.push('Games'); state.schema.Games = { primary: 'Name', fields: [{ name: 'Studio', required: false }, { name: 'Year', required: false }] }; rebuildCatSelects();`);
    await cloud(A, 'uploadToFirestore()');
    await removeFieldInEditor(A, 'Year', 'Games');
    await cloud(A, 'pullFromFirestore()');
    assert.deepEqual(fieldNames(A, 'Games'), ['Studio']);
    assert.deepEqual(cloudFieldNames('Games'), ['Studio']);
  });

  test('the warning names the field, and cancelling changes nothing', async () => {
    const before = baselineId();
    A.run('window.__asked = ""; window.confirm = m => { window.__asked = m; return false; };');
    await removeFieldInEditor(A, 'Director');
    assert.match(A.get('window.__asked'), /Removing "Director" from Movies resets the shared baseline/);
    assert.deepEqual(fieldNames(A), ['Year', 'Director']);
    assert.equal(baselineId(), before);
  });

  test('blocked while offline: nothing changes', async () => {
    const before = baselineId();
    Object.defineProperty(A.window.navigator, 'onLine', { get: () => false, configurable: true });
    await removeFieldInEditor(A, 'Director');
    assert.deepEqual(fieldNames(A), ['Year', 'Director']);
    assert.equal(baselineId(), before);
    assert.match(toasts(), /offline — removing a field resets/);
  });

  test('blocked when signed out on a device that has synced', async () => {
    A.run('cloudUser = null');
    await removeFieldInEditor(A, 'Director');
    assert.deepEqual(fieldNames(A), ['Year', 'Director']);
    assert.match(toasts(), /Sign in to cloud sync first — removing a field/);
  });
});

test('a device that has never synced removes it in place, without a reset', async () => {
  const L = loadApp(); others.push(L);
  seed(L, 'dL');
  await removeFieldInEditor(L, 'Director');
  assert.deepEqual(fieldNames(L), ['Year']);
});

test('changing other field settings still saves instantly, without a reset', async () => {
  const before = baselineId();
  A.run(`document.getElementById('sel-cat').value = 'Movies'; openSchemaEditor(); toggleMulti(1);`);
  await A.window.eval('saveSchema()');
  assert.equal(A.get("state.schema.Movies.fields.find(f => f.name === 'Director').multi"), true);
  assert.equal(baselineId(), before);
});

describe("a built-in category's default fields don't come back from an empty library (2.22.0)", () => {
  // freshState() gives every built-in category its CAT_DEFAULTS fields. The additive merge
  // kept them all, so a device that adopted a reset or started fresh still had a removed
  // default field (Songs' "Year", real report), and its next Upload put it back everywhere.
  beforeEach(() => removeFieldInEditor(A, 'Director'));

  test('a brand-new device takes the cloud\'s fields, and its upload keeps them', async () => {
    const C = loadApp(); others.push(C);
    connect(C, db, { email: 'c@example.com' });
    await cloud(C, 'pullFromFirestore()');
    assert.deepEqual(fieldNames(C), ['Year']);
    await cloud(C, 'uploadToFirestore()');
    assert.deepEqual(cloudFieldNames(), ['Year']);
  });

  test('"Adopt fresh baseline" takes the cloud\'s fields', async () => {
    await B.window.eval('adoptFreshBaseline()');
    assert.deepEqual(fieldNames(B), ['Year']);
  });

  test('fields this device changed in a built-in category still merge', async () => {
    const C = loadApp(); others.push(C);
    connect(C, db, { email: 'c@example.com' });
    C.run(`state.schema.Movies.fields.push({ name: 'Rating', required: false })`);
    await cloud(C, 'pullFromFirestore()');
    assert.deepEqual(fieldNames(C), ['Year', 'Director', 'Rating']);
  });
});

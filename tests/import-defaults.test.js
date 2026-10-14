// Importing a JSON backup into an empty library (2.22.1). "Clear all data" leaves the
// built-in categories with their CAT_DEFAULTS fields (freshState()), and the import merged
// the backup into those defaults additively, so a removed default field came back and a
// filterable flag turned off came back on. Found rehearsing a real library conversion: the
// Songs backup had no "Year" (removed in 2.22.0) and a non-filterable Album, and after
// Clear + Import both were back; a Reset would have published them to every device.
// 2.22.0 already took the cloud's fields as-is for a pull into an empty library; imports
// now do the same (dropUntouchedDefaultSchemas()). Runs the real import code after the
// file is read (importPayload()).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let app;
afterEach(() => app.close());

// The user's Songs fields: no "Year", Album not filterable, Artist an identity field.
const SONGS = { primary: 'Title', fields: [
  { name: 'Artist', required: true, identity: true },
  { name: 'Album', required: false, filterable: false },
  { name: 'Language', required: false },
  { name: 'Genre', required: false, multi: true },
  { name: 'Year Released', required: false },
] };

function backup({ schema = { Songs: SONGS }, cats = ['Movies', 'Songs'] } = {}) {
  const id = app.get(`itemKey('Songs', 'Numb', identitySuffixFor('Songs', { Artist: 'Linkin Park' }))`);
  return {
    _meta: { appVersion: '2.22.0', dataSchemaVersion: 6, exportedAt: '2026-10-14T00:00:00.000Z' },
    cats, schema,
    items: { [id]: { id, cat: 'Songs', title: 'Numb', fields: { Artist: 'Linkin Park', Album: 'Meteora' }, elo: 1040, wins: 3, losses: 1, updatedAt: 1 } },
    matchLog: [], history: [], itemDeletes: [], itemUndeletes: [], catDeletes: [], catUndeletes: [],
    settings: { smartPairMode: false, matchSeq: 0 },
  };
}
const fields = (cat = 'Songs') => app.get(`state.schema[${JSON.stringify(cat)}].fields`);
const importIt = d => app.run(`importPayload(${JSON.stringify(d)})`);

test('Clear all data, then import: the backup\'s fields are kept exactly', () => {
  app = loadApp();
  app.run('clearAllDataCore()');
  importIt(backup());
  assert.deepEqual(fields().map(f => f.name), ['Artist', 'Album', 'Language', 'Genre', 'Year Released'], '"Year" came back');
  assert.equal(fields().find(f => f.name === 'Album').filterable, false, 'Album became filterable again');
  assert.equal(Object.values(app.get('state.items'))[0].elo, 1040, 'the rating was kept');
});

test('a built-in category the backup lacks keeps its defaults', () => {
  app = loadApp();
  importIt(backup());
  assert.deepEqual(fields('Movies'), app.get('CAT_DEFAULTS.Movies.fields'));
});

test('a built-in category this device already edited still merges additively', () => {
  app = loadApp();
  app.run(`state.schema.Songs.fields.push({ name: 'Mood', required: false })`);
  importIt(backup());
  const names = fields().map(f => f.name);
  assert.ok(names.includes('Mood'), "this device's own field was dropped");
  assert.ok(names.includes('Year Released'), "the backup's field wasn't added");
});

test('importing into a library that has items still merges additively', () => {
  app = loadApp();
  const id = app.call('itemKey', 'Movies', 'Heat');
  app.run(`state.items[${JSON.stringify(id)}] = { id: ${JSON.stringify(id)}, cat: 'Movies', title: 'Heat', fields: {}, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 }`);
  importIt(backup());
  assert.ok(fields().some(f => f.name === 'Year'), 'a non-empty library should keep its own fields');
  assert.equal(Object.keys(app.get('state.items')).length, 2);
});

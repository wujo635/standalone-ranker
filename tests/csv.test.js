// CSV export and import (2.21.1): a category exported with "Export CSV" must import back
// as the same items — same titles, so the same ids. Two ways it didn't: a title starting
// with # was read as a directive row and dropped, and a title with a double quote lost
// the quote ("" wasn't read back as an escape), landing on a different id.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

const open = [];
afterEach(() => open.splice(0).forEach(app => app.close()));
function page() { const app = loadApp(); open.push(app); return app; }

const SONGS = [
  ['#Cookie Jar', 'Red Velvet'],
  ['The "Real" Slim Shady', 'Eminem'],
  ['Say "Hi", Then Leave', 'Someone'],
  ["'Cause it's you", 'Red Velvet'],
  ['안녕, 여름 (Parade)', 'Red Velvet'],
  ['Plain', 'Someone "Quoted"'],
];

function seed(app) {
  app.run(`${JSON.stringify(SONGS)}.forEach(([title, Artist]) => {
    const fields = { Artist, Album: '', 'Year Released': '', Language: '', Genre: '' };
    const id = itemKey('Songs', title, identitySuffixFor('Songs', fields));
    state.items[id] = { id, cat: 'Songs', title, fields, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 };
  }); save();`);
}
// Library -> Export CSV for Songs, capturing the file instead of downloading it.
function exportSongs(app) {
  app.run(`window.__csv = null;
    Blob = class { constructor(parts) { window.__csv = parts.join(''); } };
    URL.createObjectURL = () => 'blob:csv';
    HTMLAnchorElement.prototype.click = () => {};
    document.getElementById('sel-cat').value = 'Songs';
    exportCategoryCSV();`);
  return app.get('window.__csv');
}
// The real import path; on a device that already has the category, choose Bulk add.
function importCSV(app, text) {
  app.window.prompt = () => '1';
  app.run(`resolveCSVImport(parsePreloadCSV(${JSON.stringify(text)}))`);
}
const songs = app => Object.values(app.get('state.items')).filter(i => i.cat === 'Songs')
  .map(i => ({ id: i.id, title: i.title, Artist: i.fields.Artist })).sort((a, b) => a.id.localeCompare(b.id));

describe('CSV round trip (2.21.1)', () => {
  test('every title comes back exactly, on its original id', () => {
    const A = page(); seed(A);
    const csv = exportSongs(A);
    const B = page();
    importCSV(B, csv);
    assert.deepEqual(songs(B), songs(A));
  });

  test('importing the export into the same library adds nothing', () => {
    const A = page(); seed(A);
    const before = songs(A);
    importCSV(A, exportSongs(A));
    assert.deepEqual(songs(A), before);
  });

  test('a title starting with # is quoted on export', () => {
    const A = page(); seed(A);
    assert.ok(exportSongs(A).split('\n').includes('"#Cookie Jar",Red Velvet,,,,'));
  });

  test('an older export with an unquoted # title still imports it as a row', () => {
    const B = page();
    importCSV(B, ['#category,Songs', '#primary,Title', '#field,Artist,required', 'Title,Artist',
      'Heat,Someone', '#Cookie Jar,Red Velvet'].join('\n'));
    assert.deepEqual(songs(B).map(s => s.title).sort(), ['#Cookie Jar', 'Heat']);
  });

  test('a directive after the header is still a directive', () => {
    const r = loadApp(); open.push(r);
    const result = r.call('parsePreloadCSV', ['#category,Songs', 'Title,Artist', '#primary,Title', '#field,Artist,required', 'Heat,Someone'].join('\n'));
    assert.equal(result.primary, 'Title');
    assert.deepEqual(result.items.map(i => i.title), ['Heat']);
  });

  test('quoted commas and escaped quotes split into the right cells', () => {
    const app = page();
    assert.deepEqual(app.call('splitCSVLine', '"a, ""b""",c,"",""""'), ['a, "b"', 'c', '', '"']);
  });
});

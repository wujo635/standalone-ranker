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

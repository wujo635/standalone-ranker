// Click-level UI tests: every interactive control in the app, driven by real DOM events
// (click / change / keydown / keyup / mousedown) on the real page.
//
// These exist to guard refactors of how events are wired up (item 11: inline onclick=
// attributes → delegated handlers). So elements are found the way a user finds them —
// by id, visible text, aria-label, or title — never by their onclick/onchange attribute,
// and each test checks either the function the control should call (with its arguments)
// or the visible result.
//
// Spying: `spy(name)` swaps the page's global function for a recorder. Handlers must look
// functions up by name when the event fires (inline handlers do; a delegated dispatcher
// must too), otherwise the spy is bypassed and the test fails — which is intentional.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let app, doc;
beforeEach(() => {
  app = loadApp();
  doc = app.window.document;
  seed();
});
afterEach(() => app.close());

// --- fixture ---------------------------------------------------------------------

const MOVIES = [
  ['Heat', '1995', 'Michael Mann'],
  ['Ronin', '1998', 'John Frankenheimer'],
  ['Thief', '1981', 'Michael Mann'],
  ['Collateral', '2004', 'Michael Mann'],
];
const key = (title, cat = 'Movies') => app.call('itemKey', cat, title);

function seed() {
  const s = app.get('freshState()');
  const add = (cat, title, fields, elo = 1000) => {
    const id = app.call('itemKey', cat, title);
    s.items[id] = { id, cat, title, fields, elo, wins: 0, losses: 0, hidden: false, updatedAt: 1 };
    return id;
  };
  MOVIES.forEach(([t, y, d], i) => add('Movies', t, { Year: y, Director: d }, 1000 + i));
  // Songs' Genre is a multi-value field in the default schema.
  add('Songs', 'Paranoid Android', { Artist: 'Radiohead', Genre: 'Rock, Art Rock' });
  add('Songs', 'So What', { Artist: 'Miles Davis', Genre: 'Jazz' });
  // A category big enough to paginate the Library and batch the Leaderboard.
  s.cats.push('Big');
  s.schema.Big = { primary: 'Name', fields: [] };
  for (let n = 0; n < 60; n++) add('Big', 'Item ' + String(n).padStart(2, '0'), {}, 1000 + n);
  // One undoable ranking, and enough deletions for the Deleted Items "Show all" toggle.
  const heat = app.call('itemKey', 'Movies', 'Heat'), ronin = app.call('itemKey', 'Movies', 'Ronin');
  s.history = [{ type: 'standard', category: 'Movies', timestamp: 1,
    winner: { id: heat, title: 'Heat', eloChange: 16 }, loser: { id: ronin, title: 'Ronin', eloChange: -16 }, matchIds: [] }];
  for (let n = 0; n < 51; n++) s.itemDeletes.push({ itemId: 'igone' + n, ts: 100 + n, deviceId: 'dX', title: 'Gone ' + n, cat: 'Movies' });
  app.setState(s);
  // State was written directly, so reset what the page derived while it loaded empty:
  // the field-type cache (the app's own add/import paths clear it) and the filter
  // placeholders, which record each field's type when first built.
  app.run(`fieldTypeCache = {}; filterState = {}; rebuildCatSelects(); document.getElementById('sel-cat').value = 'Movies'; renderLibrary();`);
}

// --- helpers ---------------------------------------------------------------------

// Replaces a page function with a recorder. Element arguments (e.g. updateFilter(this))
// are recorded as their dataset; events as their type. Returns the list of calls.
function spy(name, { passthrough = false } = {}) {
  const win = app.window;
  const original = win[name];
  assert.equal(typeof original, 'function', `${name} should be a global function`);
  const calls = [];
  win[name] = function (...args) {
    calls.push(args.map(a =>
      a instanceof win.Element ? { ...a.dataset } :
      a instanceof win.Event ? { event: a.type } : a));
    if (passthrough) return original.apply(this, args);
  };
  return calls;
}

const $ = sel => doc.querySelector(sel);
const $$ = sel => [...doc.querySelectorAll(sel)];
function byText(sel, text) {
  const el = $$(sel).find(e => e.textContent.trim() === text || e.textContent.trim().startsWith(text));
  assert.ok(el, `no ${sel} with text "${text}"`);
  return el;
}
const click = el => el.click();
function change(el, value) {
  if (value !== undefined) {
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
  }
  el.dispatchEvent(new app.window.Event('change', { bubbles: true }));
}
function press(el, k, type = 'keydown') {
  el.dispatchEvent(new app.window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
}
const activeView = () => $('.view.active').id;
const libTitles = () => $$('#lib-list .item-title').map(e => e.firstChild.textContent.trim());
const tab = name => byText('nav button', name);
function openRank(cat = 'Movies') {
  click(tab('Rank'));
  change($('#rank-cat'), cat);
}

// --- navigation --------------------------------------------------------------------

describe('navigation', () => {
  for (const [label, view] of [['Rank', 'view-rank'], ['Leaderboard', 'view-leaderboard'], ['History', 'view-history'], ['Data', 'view-data'], ['Library', 'view-library']]) {
    test(`the ${label} tab opens ${view}`, () => {
      if (label === 'Library') click(tab('Data'));
      click(tab(label));
      assert.equal(activeView(), view);
    });
  }
});

// --- Library -----------------------------------------------------------------------

describe('Library', () => {
  test("changing the category clears the search and the new category's filters, and shows it", () => {
    $('#lib-search').value = 'heat';
    app.run(`filterState.Big = { Name: { type: 'string', values: ['x'] } }`);
    change($('#sel-cat'), 'Big');
    assert.equal($('#lib-search').value, '');
    assert.equal(app.get("activeFilterKey('Big')"), '{}', 'no active filters left');
    assert.ok(libTitles().includes('Item 00'));
  });

  test('"+ New category" opens the new-category view', () => {
    click(byText('#view-library button', '+ New category'));
    assert.equal(activeView(), 'view-newcat');
  });

  test('"⚙ Fields" opens the schema editor', () => {
    click($('#view-library button[title="Edit fields"]'));
    assert.equal(activeView(), 'view-schema');
  });

  test('typing in search filters the list', () => {
    $('#lib-search').value = 'thi';
    press($('#lib-search'), 'i', 'keyup');
    assert.deepEqual(libTitles(), ['Thief']);
  });

  test('the search ✕ button clears the search, and pressing it doesn\'t steal focus', () => {
    $('#lib-search').value = 'thi';
    press($('#lib-search'), 'i', 'keyup');
    const btn = $('button[aria-label="Clear search"]');
    const down = new app.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true, 'mousedown default prevented');
    click(btn);
    assert.equal($('#lib-search').value, '');
    assert.equal(libTitles().length, MOVIES.length);
  });

  test('Enter in the add form (title or a field) and the Add button all call addItem()', () => {
    const calls = spy('addItem');
    press($('#inp-primary'), 'Enter');
    press($('#add-form input[id^="field-"]'), 'Enter');
    press($('#inp-primary'), 'a'); // other keys do nothing
    click(byText('#add-form button', 'Add'));
    assert.equal(calls.length, 3);
  });

  test('the Add button really adds the item', () => {
    $('#inp-primary').value = 'Manhunter';
    click(byText('#add-form button', 'Add'));
    assert.ok(libTitles().includes('Manhunter'));
  });

  test('bulk hide / unhide buttons call bulkSetHidden(true/false)', () => {
    const calls = spy('bulkSetHidden');
    click(byText('#lib-list button', '◎ Hide all matching'));
    click(byText('#lib-list button', '◉ Unhide all matching'));
    assert.deepEqual(calls, [[true], [false]]);
  });

  test('Next / Prev page buttons call libGoToPage with the right page', () => {
    change($('#sel-cat'), 'Big');
    const calls = spy('libGoToPage', { passthrough: true });
    click(byText('#lib-list button', 'Next ›'));
    click(byText('#lib-list button', '‹ Prev'));
    assert.deepEqual(calls, [[2], [1]]);
  });

  test('a row\'s Hide / Edit / Remove buttons act on that row\'s item', () => {
    const hide = spy('toggleHidden'), edit = spy('editItem'), del = spy('deleteItem');
    click($('button[aria-label="Hide Heat"]'));
    click($('button[aria-label="Edit Heat"]'));
    click($('button[aria-label="Remove Heat"]'));
    assert.deepEqual([hide, edit, del], [[[key('Heat')]], [[key('Heat')]], [[key('Heat')]]]);
  });

  test('in an open edit row, Save / Cancel / Enter / Escape call saveItem or editItem for that item', () => {
    app.run(`editItem(${JSON.stringify(key('Heat'))})`);
    const save = spy('saveItem'), edit = spy('editItem');
    const row = $(`#edit-primary-${key('Heat')}`).closest('.edit-row');
    click(byText('.edit-row button', 'Save'));
    click(byText('.edit-row button', 'Cancel'));
    press($(`#edit-primary-${key('Heat')}`), 'Enter');
    press($(`#edit-primary-${key('Heat')}`), 'Escape');
    press(row.querySelector('input[id^="edit-field-"]'), 'Enter');
    press(row.querySelector('input[id^="edit-field-"]'), 'Escape');
    assert.deepEqual(save, [[key('Heat')], [key('Heat')], [key('Heat')]]);
    assert.deepEqual(edit, [[key('Heat')], [key('Heat')], [key('Heat')]]);
  });
});

// --- filter panel ------------------------------------------------------------------

describe('filter panel', () => {
  const header = () => $('#lib-filters .filter-panel-header');
  const fields = () => header().nextElementSibling;
  const expand = () => { if (fields().style.display === 'none') click(header()); };

  test('clicking the header expands and collapses it', () => {
    const before = fields().style.display;
    click(header());
    assert.notEqual(fields().style.display, before);
    click(header());
    assert.equal(fields().style.display, before);
  });

  test('checking a value narrows the list', () => {
    expand();
    const box = $$('#lib-filters input[data-field="Director"]').find(i => i.dataset.value === 'Michael Mann');
    change(box, true);
    assert.deepEqual(libTitles().sort(), ['Collateral', 'Heat', 'Thief']);
  });

  test('a numeric min narrows the list', () => {
    expand();
    change($('#lib-filters input[data-field="Year"][data-op="min"]'), '2000');
    assert.deepEqual(libTitles(), ['Collateral']);
  });

  test('a numeric max narrows the list', () => {
    expand();
    change($('#lib-filters input[data-field="Year"][data-op="max"]'), '1990');
    assert.deepEqual(libTitles(), ['Thief']);
  });

  test('a numeric exact value narrows the list', () => {
    expand();
    change($('#lib-filters input[data-field="Year"][data-op="equals"]'), '1998');
    assert.deepEqual(libTitles(), ['Ronin']);
  });

  test('checking one token of a multi-value field matches items that have it', () => {
    change($('#sel-cat'), 'Songs');
    expand();
    const box = $$('#lib-filters input[data-field="Genre"]').find(i => i.dataset.value === 'Rock');
    assert.ok(box, 'Genre offers individual tokens, e.g. "Rock"');
    change(box, true);
    assert.deepEqual(libTitles(), ['Paranoid Android']);
  });

  test("a field's filter follows its type when the type changes during a session (2.17.3)", () => {
    // The page builds filter entries for an empty Movies category, so Year is inferred
    // as text. Adding items with numeric Years makes it a number field — its min/max
    // filter must then actually apply. Before 2.17.3 the entry kept type 'string'.
    app.run(`state.items = {}; fieldTypeCache = {}; filterState = {}; renderLibrary();`);
    expand();
    for (const [t, y] of [['Heat', '1995'], ['Thief', '1981'], ['Collateral', '2004']]) {
      $('#inp-primary').value = t;
      $('#field-Year').value = y;
      click(byText('#add-form button', 'Add'));
    }
    expand();
    change($('#lib-filters input[data-field="Year"][data-op="min"]'), '2000');
    assert.deepEqual(libTitles(), ['Collateral']);
  });

  test('"Has value" calls updateFilter for that field', () => {
    expand();
    const calls = spy('updateFilter');
    change($('#lib-filters input[data-field="Director"][data-op="nonblank"]'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].field, 'Director');
    assert.equal(calls[0][0].op, 'nonblank');
  });

  test('✕ Clear clears every filter without collapsing the panel', () => {
    expand();
    change($('#lib-filters input[data-field="Year"][data-op="min"]'), '2000');
    expand();
    click(byText('#lib-filters button', '✕ Clear'));
    assert.equal(libTitles().length, MOVIES.length);
    assert.notEqual(fields().style.display, 'none');
  });
});

// --- New Category & Schema Editor --------------------------------------------------

describe('New Category view', () => {
  beforeEach(() => click(byText('#view-library button', '+ New category')));

  test('Enter in the field name and the Add field button call addNewCatField()', () => {
    const calls = spy('addNewCatField');
    press($('#newcat-field-inp'), 'Enter');
    click(byText('#view-newcat button', 'Add field'));
    assert.equal(calls.length, 2);
  });

  test('a pending field\'s ✕ removes it', () => {
    $('#newcat-field-inp').value = 'Rating';
    click(byText('#view-newcat button', 'Add field'));
    const calls = spy('removePendingField', { passthrough: true });
    click(byText('#view-newcat .field-row button', '✕'));
    assert.deepEqual(calls, [[0]]);
  });

  test('Cancel returns to the Library; Create category calls saveNewCat()', () => {
    const calls = spy('saveNewCat');
    click(byText('#view-newcat button', 'Create category'));
    assert.equal(calls.length, 1);
    click(byText('#view-newcat button', 'Cancel'));
    assert.equal(activeView(), 'view-library');
  });
});

describe('Schema Editor', () => {
  beforeEach(() => click($('#view-library button[title="Edit fields"]')));
  const rowButton = (fieldIdx, sel) => $$('#view-schema .field-row')[fieldIdx].querySelector(sel);

  test('Enter in the new field name and the Add button call addSchemaField()', () => {
    const calls = spy('addSchemaField');
    press($('#schema-field-inp'), 'Enter');
    click(byText('#view-schema button', 'Add'));
    assert.equal(calls.length, 2);
  });

  test('each field\'s toggles call their function with that field\'s index', () => {
    const req = spy('toggleRequired'), filt = spy('toggleFilterable'), ident = spy('toggleIdentity'), multi = spy('toggleMulti'), rm = spy('removeEditingField');
    click(rowButton(1, 'button[title="Toggle required/optional"]'));
    click(rowButton(1, 'button[title="Toggle in filter UI"]'));
    click(rowButton(1, 'button[title^="Toggle identity field"]'));
    click(rowButton(1, 'button[title^="Toggle multi-value"]'));
    click([...$$('#view-schema .field-row')[1].querySelectorAll('button')].pop());
    assert.deepEqual([req, filt, ident, multi, rm], [[[1]], [[1]], [[1]], [[1]], [[1]]]);
  });

  test('Delete category, Save, and Cancel', () => {
    const del = spy('confirmDeleteCat'), save = spy('saveSchema');
    click(byText('#view-schema button', 'Delete category'));
    click(byText('#view-schema button', 'Save'));
    assert.equal(del.length, 1);
    assert.equal(save.length, 1);
    click(byText('#view-schema button', 'Cancel'));
    assert.equal(activeView(), 'view-library');
  });
});

// --- Rank --------------------------------------------------------------------------

describe('Rank', () => {
  test('changing the category resets the session counter and reloads the view', () => {
    click(tab('Rank'));
    app.run('standardSessionVotes = 5');
    const calls = spy('initRankView');
    change($('#rank-cat'), 'Movies');
    assert.equal(app.get('standardSessionVotes'), 0);
    assert.equal(calls.length, 1);
  });

  test('mode buttons call setRankMode with their mode', () => {
    openRank();
    const calls = spy('setRankMode');
    click($('#mode-btn-podium'));
    click($('#mode-btn-tier'));
    click($('#mode-btn-standard'));
    assert.deepEqual(calls, [['podium'], ['tier'], ['standard']]);
  });

  test('the Smart pairing checkbox calls toggleSmartPair with its state', () => {
    openRank();
    const calls = spy('toggleSmartPair');
    change($('#smart-pair-toggle'), true);
    change($('#smart-pair-toggle'), false);
    assert.deepEqual(calls, [[true], [false]]);
  });

  test('Skip calls initRankView()', () => {
    openRank();
    const calls = spy('initRankView');
    click($('#rank-skip-btn'));
    assert.equal(calls.length, 1);
  });

  test('clicking a 1v1 card votes for it against the other', () => {
    openRank();
    const [a, b] = app.get('currentPair.map(i => i.id)');
    const calls = spy('vote');
    const cards = $$('#rank-pair .vs-card');
    click(cards[0]);
    click(cards[1]);
    assert.deepEqual(calls, [[a, b], [b, a]]);
  });

  test('Podium: place buttons, Clear, and Confirm', () => {
    openRank();
    click($('#mode-btn-podium'));
    const assign = spy('assignPlace', { passthrough: true });
    const rows = () => $$('#rank-pair .podium-btn');
    click(rows().find(b => b.textContent === '🥇'));
    assert.equal(assign[0][1], 1);
    const firstId = assign[0][0];
    click(rows().find(b => b.textContent === '🥈'));
    click(rows().find(b => b.textContent === '🥉'));
    const clear = spy('clearPodiumPlace', { passthrough: true });
    click(byText('#rank-pair .podium-btn', 'Clear'));
    assert.equal(clear.length, 1);
    click(rows().find(b => ['🥇', '🥈', '🥉'].includes(b.textContent))); // re-fill the freed place
    const submit = spy('submitPodium');
    click(byText('#rank-pair button', 'Confirm podium'));
    assert.equal(submit.length, 1);
    assert.equal(typeof firstId, 'string');
  });

  test('Tier: Start session, tier buttons, chip ×, and Confirm', () => {
    openRank();
    click($('#mode-btn-tier'));
    const start = spy('startTierSession', { passthrough: true });
    $('#tier-size-input').value = '3';
    click(byText('#rank-pair button', 'Start session'));
    assert.equal(start.length, 1);
    const assign = spy('assignTier', { passthrough: true });
    const firstS = $('#rank-pair .tier-item-btn');
    const id = firstS.dataset.id;
    click(firstS);
    assert.deepEqual(assign[0], [id, firstS.dataset.tier]);
    const remove = spy('removeTierPlacement', { passthrough: true });
    click($('#rank-pair .tier-chip-remove'));
    assert.deepEqual(remove, [[id]]);
    // Place every item in the session (its size can be smaller than requested — see
    // startTierSession()'s unranked cap), until Confirm appears.
    while ($('#rank-pair .tier-item-btn')) click($('#rank-pair .tier-item-btn'));
    const submit = spy('submitTier');
    click(byText('#rank-pair button', 'Confirm tier results'));
    assert.equal(submit.length, 1);
  });
});

// --- History, Leaderboard, Data ------------------------------------------------------

describe('History', () => {
  test('Undo calls undoRanking with the entry index', () => {
    click(tab('History'));
    const calls = spy('undoRanking');
    click(byText('#history-list button', '↶ Undo'));
    assert.deepEqual(calls, [[0]]);
  });
});

describe('Leaderboard', () => {
  test('a category pill switches the leaderboard to that category', () => {
    click(tab('Leaderboard'));
    click(byText('#lb-cats .pill', 'Big'));
    assert.equal(app.get('lbCat'), 'Big');
    assert.equal($('#lb-cats .pill.active').textContent, 'Big');
  });

  test('category names with quotes and apostrophes survive being passed to handlers', () => {
    // User text travels in data-args (argsAttr() escapes it). This is the class of bug
    // fixed in 2.15.0, when names were spliced into inline JS strings.
    const cat = `Director's "Cut"`;
    const id = key('X', cat);
    app.run(`state.cats.push(${JSON.stringify(cat)}); state.schema[${JSON.stringify(cat)}] = { primary: 'Title', fields: [{ name: 'Tag', required: false }] };
      state.items[${JSON.stringify(id)}] = { id: ${JSON.stringify(id)}, cat: ${JSON.stringify(cat)}, title: 'X', fields: { Tag: 'a' }, elo: 1000, wins: 0, losses: 0, hidden: false, updatedAt: 1 };
      rebuildCatSelects();`);
    click(tab('Leaderboard'));
    click(byText('#lb-cats .pill', cat));
    assert.equal(app.get('lbCat'), cat);
    click(tab('Library'));
    change($('#sel-cat'), cat);
    const header = $('#lib-filters .filter-panel-header');
    if (header.nextElementSibling.style.display === 'none') click(header);
    change($('#lib-filters input[data-field="Tag"][data-value="a"]'), true);
    const clear = spy('clearAllFilters');
    click(byText('#lib-filters button', '✕ Clear'));
    assert.deepEqual(clear, [[cat]]);
  });

  test('Show all loads every row', () => {
    click(tab('Leaderboard'));
    click(byText('#lb-cats .pill', 'Big'));
    assert.equal($$('#lb-rows .item-row').length, 50);
    click(byText('#lb-footer button', 'Show all'));
    assert.equal($$('#lb-rows .item-row').length, 60);
  });
});

describe('Data tab', () => {
  beforeEach(() => click(tab('Data')));

  test('export buttons call exportData() / exportCategoryCSV()', () => {
    const json = spy('exportData'), csv = spy('exportCategoryCSV');
    click(byText('#view-data button', '↓ Export JSON'));
    click(byText('#view-data button', '↓ Export category as CSV'));
    assert.equal(json.length, 1);
    assert.equal(csv.length, 1);
  });

  test('choosing a JSON or CSV file calls importData / importCSV with the event', () => {
    const json = spy('importData'), csv = spy('importCSV');
    change($('#file-inp'));
    change($('#csv-inp'));
    assert.deepEqual(json, [[{ event: 'change' }]]);
    assert.deepEqual(csv, [[{ event: 'change' }]]);
  });

  test('cloud buttons call their functions', () => {
    const fns = ['uploadToFirestore', 'pullFromFirestore', 'resetSharedBaseline', 'adoptFreshBaseline', 'exportRecoveryBaseline'];
    const calls = Object.fromEntries(fns.map(f => [f, spy(f)]));
    for (const id of ['#cloud-upload-btn', '#cloud-pull-btn', '#cloud-reset-btn', '#cloud-adopt-btn', '#cloud-recovery-btn']) {
      $(id).disabled = false;
      click($(id));
    }
    assert.deepEqual(fns.map(f => calls[f].length), [1, 1, 1, 1, 1]);
  });

  test('"See format guide" toggles the CSV help without following the link', () => {
    const calls = spy('showCsvHelp');
    const link = byText('#view-data a', 'See format guide');
    const ev = new app.window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    assert.equal(calls.length, 1);
    assert.equal(ev.defaultPrevented, true);
  });

  test('Clear all data calls clearAllData()', () => {
    const calls = spy('clearAllData');
    click(byText('#view-data button', 'Clear all data'));
    assert.equal(calls.length, 1);
  });

  test('Deleted items: Show all / Show fewer, and Undelete', () => {
    app.run('renderDeletedItems()');
    const rows = () => $$('#deleted-items-list button').filter(b => b.textContent === 'Undelete').length;
    assert.equal(rows(), 50);
    click(byText('#deleted-items-list button', 'Show all'));
    assert.equal(rows(), 51);
    click(byText('#deleted-items-list button', 'Show fewer'));
    assert.equal(rows(), 50);
    const calls = spy('undeleteItem');
    click(byText('#deleted-items-list button', 'Undelete'));
    assert.deepEqual(calls, [['igone50']]);
  });

  test('Sign in / Sign out call cloudSignIn() / cloudSignOut()', () => {
    const signIn = spy('cloudSignIn'), signOut = spy('cloudSignOut');
    app.run('cloudAvailable = true; cloudUser = null; renderCloudAuthUI()');
    click(byText('#cloud-auth button', 'Sign in with Google'));
    app.run("cloudUser = { email: 'a@example.com' }; renderCloudAuthUI()");
    click(byText('#cloud-auth button', 'Sign out'));
    assert.equal(signIn.length, 1);
    assert.equal(signOut.length, 1);
  });
});

// --- save-warning banner --------------------------------------------------------------

describe('save-warning banner', () => {
  test('"Export backup now" (storage full) calls exportData()', () => {
    app.run('saveFailed = true; saveFailedQuota = true; renderSaveWarning()');
    const calls = spy('exportData');
    click(byText('#save-warning button', 'Export backup now'));
    assert.equal(calls.length, 1);
  });

  test('unreadable-data buttons call their recovery functions', () => {
    app.run("loadFailed = { message: 'bad', raw: '{x' }; renderSaveWarning()");
    const dl = spy('downloadUnreadableData'), discard = spy('discardUnreadableData');
    click(byText('#save-warning button', 'Download raw saved data'));
    click(byText('#save-warning button', 'Discard and resume saving'));
    assert.equal(dl.length, 1);
    assert.equal(discard.length, 1);
  });
});

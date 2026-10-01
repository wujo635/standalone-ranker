// Tier session pool selection (startTierSession()): a session should contain exactly
// the number of items asked for (the start screen only allows up to the category's
// size), with never-ranked items prioritised.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let app;
beforeEach(() => { app = loadApp(); });
afterEach(() => app.close());

// `unranked` items with no comparisons, `ranked` items with some.
function seed({ unranked = 0, ranked = 0 }) {
  const s = app.get('freshState()');
  s.cats.push('T');
  s.schema.T = { primary: 'Name', fields: [] };
  const add = (title, played) => {
    const id = app.call('itemKey', 'T', title);
    s.items[id] = { id, cat: 'T', title, fields: {}, elo: 1000 + played, wins: played, losses: 0, hidden: false, updatedAt: 1 };
  };
  for (let n = 0; n < unranked; n++) add('U' + n, 0);
  for (let n = 0; n < ranked; n++) add('R' + n, 1 + n);
  app.setState(s);
  app.run(`rebuildCatSelects(); switchTab('rank'); document.getElementById('rank-cat').value = 'T'; setRankMode('tier');`);
}

function startSession(n, { smart = false } = {}) {
  // loadTier() shows the start screen (with the size input) again, as Skip/a new session would.
  app.run(`smartPairMode = ${smart}; loadTier(); document.getElementById('tier-size-input').value = '${n}'; startTierSession();`);
  return app.get('tierPool.map(i => i.title)');
}

describe('Tier session size', () => {
  test('a fresh category (all unranked) gets the full requested size', () => {
    seed({ unranked: 4 });
    assert.equal(startSession(3).length, 3, 'asked for 3; was 2 before the fix');
  });

  test('asking for 10 in a fresh 100-item category gives 10', () => {
    seed({ unranked: 100 });
    assert.equal(startSession(10).length, 10, 'was 5 before the fix');
  });

  test('a mostly-unranked category with a few ranked items still fills the session', () => {
    seed({ unranked: 20, ranked: 2 });
    for (const smart of [false, true]) assert.equal(startSession(10, { smart }).length, 10, `smart=${smart}`);
  });

  test('asking for the whole category gives every item, each once', () => {
    seed({ unranked: 3, ranked: 4 });
    const pool = startSession(7);
    assert.equal(new Set(pool).size, 7);
  });

  test('never-ranked items are still prioritised (up to half the session)', () => {
    seed({ unranked: 2, ranked: 20 });
    const pool = startSession(6);
    assert.equal(pool.length, 6);
    assert.ok(pool.includes('U0') && pool.includes('U1'), 'both unranked items included');
  });

  test('a fully ranked category is unaffected', () => {
    seed({ ranked: 10 });
    for (const smart of [false, true]) assert.equal(startSession(5, { smart }).length, 5, `smart=${smart}`);
  });
});

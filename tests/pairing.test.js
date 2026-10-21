// Which items the Rank view puts in front of the user (1v1 pairs, Podium rounds, Tier
// sessions). In a large category a new item used to almost never come up: a uniformly
// random pick among thousands rarely lands on it, so it stayed at 1000 indefinitely.
// Under-played items — fewer matches than is typical for the category — are now drawn
// more often, Smart pairing picks among the few nearest ratings (aiming wider for an
// under-played item), and a pair just shown isn't shown again right away.
//
// Draws are random, so Math.random is replaced with a seeded generator: every run sees
// the same sequence, and thresholds are set well clear of both the old and new rates.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let app;
beforeEach(() => { app = loadApp(); });
afterEach(() => app.close());

// --- helpers -------------------------------------------------------------------

// A category 'T' of `settled` items spread evenly over ratings 700–1300, each with
// `games` matches, plus `extra` items given as { title, elo, games }.
function seed({ settled = 0, games = 10, extra = [] } = {}) {
  const s = app.get('freshState()');
  s.cats.push('T');
  s.schema.T = { primary: 'Name', fields: [] };
  const add = (title, elo, g) => {
    const id = app.call('itemKey', 'T', title);
    s.items[id] = { id, cat: 'T', title, fields: {}, elo, wins: Math.ceil(g / 2), losses: Math.floor(g / 2), hidden: false, updatedAt: 1 };
  };
  for (let n = 0; n < settled; n++) add('R' + n, Math.round(700 + (600 * n) / Math.max(1, settled - 1)), games);
  for (const x of extra) add(x.title, x.elo ?? 1000, x.games ?? 0);
  app.setState(s);
  app.run(`rebuildCatSelects(); switchTab('rank'); document.getElementById('rank-cat').value = 'T';
    Math.random = (() => { let s = 20261021; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; })();`);
}
const titleOf = id => app.get(`state.items[${JSON.stringify(id)}].title`);

// n 1v1 pairs as drawn by loadPair(), as [titleA, titleB]. `fresh` clears the
// recently-shown memory before each draw, to look at one rule without the other.
function pairs(n, { smart, fresh = false }) {
  app.run(`smartPairMode = ${smart}; setRankMode('standard');`);
  return app.get(`Array.from({ length: ${n} }, () => { ${fresh ? 'recentPairs = [];' : ''} loadPair(); return currentPair.map(i => i.title); })`);
}
function podiums(n, { smart }) {
  app.run(`smartPairMode = ${smart}; setRankMode('podium');`);
  return app.get(`Array.from({ length: ${n} }, () => { loadPodium(); return podiumPool.map(i => i.title); })`);
}
function tierSession(size, { smart }) {
  app.run(`smartPairMode = ${smart}; setRankMode('tier'); loadTier(); document.getElementById('tier-size-input').value = '${size}'; startTierSession();`);
  return app.get('tierPool.map(i => i.title)');
}
const share = (draws, title) => draws.filter(d => d.includes(title)).length / draws.length;
const NEW = { title: 'New', elo: 1000, games: 0 };

// --- under-played items come up more often ---------------------------------------

describe('a new item in a large settled category', () => {
  for (const smart of [false, true]) {
    test(`comes up in a good share of 1v1 pairs (Smart pairing ${smart ? 'on' : 'off'})`, () => {
      seed({ settled: 500, games: 10, extra: [NEW] });
      const s = share(pairs(200, { smart }), 'New');
      assert.ok(s >= 0.3, `New was in ${(s * 100).toFixed(1)}% of pairs (about 0.4% before: 2 in 501)`);
    });

    test(`comes up in a good share of Podium rounds (Smart pairing ${smart ? 'on' : 'off'})`, () => {
      seed({ settled: 500, games: 10, extra: [NEW] });
      const s = share(podiums(100, { smart }), 'New');
      assert.ok(s >= 0.3, `New was in ${(s * 100).toFixed(1)}% of rounds (about 1% before)`);
    });
  }

  test('shows up on both sides of the 1v1 cards, not always on the left', () => {
    seed({ settled: 500, games: 10, extra: [NEW] });
    const withNew = pairs(200, { smart: true }).filter(p => p.includes('New'));
    const left = withNew.filter(p => p[0] === 'New').length;
    assert.ok(left > withNew.length * 0.25 && left < withNew.length * 0.75, `left ${left} of ${withNew.length}`);
  });

  test('keeps its priority until it reaches the typical match count, not just its first match', () => {
    seed({ settled: 500, games: 10, extra: [{ title: 'New', elo: 1000, games: 3 }] });
    const s = share(pairs(200, { smart: true }), 'New');
    assert.ok(s >= 0.15, `New (3 of a typical 10 matches) was in ${(s * 100).toFixed(1)}% of pairs`);
  });

  test('an item at the typical match count gets no special treatment', () => {
    seed({ settled: 500, games: 10, extra: [{ title: 'New', elo: 1000, games: 10 }] });
    const s = share(pairs(400, { smart: true }), 'New');
    assert.ok(s <= 0.05, `an ordinary item was in ${(s * 100).toFixed(1)}% of pairs`);
  });

  test('in Tier, items with few (not just zero) matches are put first', () => {
    seed({ settled: 30, games: 10, extra: [1, 2, 3, 4].map(n => ({ title: 'Few' + n, elo: 1000, games: 1 })) });
    for (const smart of [false, true, false, true, false, true]) {
      const pool = tierSession(8, { smart });
      assert.equal(pool.length, 8);
      assert.equal(new Set(pool).size, 8, `smart=${smart}: an item appears twice in one session`);
      const few = pool.filter(t => t.startsWith('Few')).length;
      assert.ok(few >= 3, `smart=${smart}: ${few} of the 4 one-match items in a session of 8 (they were drawn like settled items before)`);
    }
  });
});

describe('a category where every item has the same number of matches', () => {
  test('draws stay spread across the whole category', () => {
    seed({ settled: 40, games: 0 });
    const draws = pairs(400, { smart: false });
    const counts = {};
    draws.flat().forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    assert.equal(Object.keys(counts).length, 40, 'every item came up');
    assert.ok(Math.max(...Object.values(counts)) <= 60, `no item dominates (max ${Math.max(...Object.values(counts))} of 800 slots, ~20 expected)`);
  });
});

// --- Smart pairing: who an item is paired with ----------------------------------

describe('Smart pairing', () => {
  test("doesn't show the same pair again within the next few draws", () => {
    seed({ settled: 30, games: 10 });
    const draws = pairs(300, { smart: true }).map(p => [...p].sort().join(' | '));
    const repeats = draws.filter((p, i) => draws.slice(Math.max(0, i - 10), i).includes(p));
    assert.deepEqual(repeats, [], 'a pair came up again within 10 draws of itself');
  });

  test('a settled item is still paired with a close rating', () => {
    seed({ settled: 300, games: 10 });
    const ratings = app.get("Object.fromEntries(Object.values(state.items).map(i => [i.title, i.elo]))");
    const gaps = pairs(200, { smart: true }).map(([a, b]) => Math.abs(ratings[a] - ratings[b]));
    // 300 items over 600 points: neighbours are 2 points apart, the 3rd nearest 4–6.
    assert.ok(Math.max(...gaps) <= 10, `largest gap ${Math.max(...gaps)}`);
  });

  test('a settled item is not always paired with the same single nearest neighbour', () => {
    seed({ settled: 300, games: 10 });
    // smartPair() directly: it returns [anchor, opponent] (loadPair() then shuffles sides),
    // with the recent-pair memory cleared, so variety must come from the 3-nearest choice.
    const draws = app.get(`(() => { smartPairMode = true; const list = itemsForCat('T');
      return Array.from({ length: 600 }, () => { recentPairs = []; return smartPair(list).map(i => i.title); }); })()`);
    const partners = {};
    draws.forEach(([anchor, opp]) => { (partners[anchor] ||= new Set()).add(opp); });
    const multi = Object.values(partners).filter(p => p.size > 1).length;
    assert.ok(multi >= 20, `${multi} anchors got more than one partner`);
  });

  test('a new item is first tried against ratings well away from its own', () => {
    seed({ settled: 500, games: 10, extra: [NEW] });
    const ratings = app.get("Object.fromEntries(Object.values(state.items).map(i => [i.title, i.elo]))");
    const gaps = pairs(200, { smart: true }).filter(p => p.includes('New'))
      .map(([a, b]) => Math.abs(ratings[a === 'New' ? b : a] - 1000));
    assert.ok(gaps.length > 0, 'setup: New came up');
    assert.ok(gaps.some(g => g >= 100), `New only met ratings within ${Math.max(...gaps)} points of its own`);
  });
});

// --- edge cases ------------------------------------------------------------------

describe('small categories', () => {
  test('two items still pair (no pair to skip to)', () => {
    seed({ settled: 2, games: 3 });
    for (const smart of [false, true]) {
      const draws = pairs(5, { smart });
      draws.forEach(p => assert.deepEqual([...p].sort(), ['R0', 'R1']));
    }
  });

  test('hidden items are never drawn', () => {
    seed({ settled: 20, games: 10, extra: [NEW] });
    app.run(`state.items[${JSON.stringify(app.call('itemKey', 'T', 'New'))}].hidden = true;`);
    assert.equal(share(pairs(100, { smart: true }), 'New'), 0);
    assert.equal(share(podiums(50, { smart: true }), 'New'), 0);
  });
});

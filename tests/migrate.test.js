// migrateData() and load(): every saved-data shape the app has ever written must
// upgrade to the current schema without losing items, ratings, or history. Fixtures
// are hand-built to match each historical shape documented in CHANGELOG.md's
// "Data schema version" table.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app');

let app;
beforeEach(() => { app = loadApp(); });
afterEach(() => { app.close(); });

const migrate = data => app.call('migrateData', data);
const key = (cat, title, suffix) => app.call('itemKey', cat, title, suffix);

describe('migrateData: version chain', () => {
  test('v1 (hardcoded `year`, no schema, no _meta) upgrades all the way to current', () => {
    const out = migrate({
      cats: ['Movies'],
      items: { abc123: { id: 'abc123', cat: 'Movies', title: 'Heat', year: '1995', elo: 1100, wins: 3, losses: 1 } },
      history: [],
    });
    const id = key('Movies', 'Heat');
    assert.deepEqual(Object.keys(out.items), [id], 'random id remapped to the deterministic itemKey (v4)');
    const item = out.items[id];
    assert.deepEqual(item.fields, { Year: '1995' }, 'top-level year moved into fields (v2)');
    assert.equal(item.year, undefined);
    assert.deepEqual([item.elo, item.wins, item.losses], [1100, 3, 1], 'ratings trusted as-is, never recomputed');
    assert.equal(typeof item.updatedAt, 'number', 'updatedAt backfilled (v4)');
    assert.deepEqual(out.schema.Movies, { primary: 'Title', fields: [{ name: 'Year', required: false }] },
      'schema created (v2) then wrapped with a primary label (v3)');
    assert.equal(out.syncBase, undefined, 'v4/v5 syncBase snapshot removed again by v6');
    assert.equal(out._meta.dataSchemaVersion, app.get('DATA_SCHEMA_VERSION'));
  });

  test('unstamped data that already has `fields` is not clobbered (1.5.1 regression)', () => {
    // 1.5.1 bug: the v1 migration ran on every load and replaced real fields with {Year: ''}.
    const out = migrate({
      cats: ['Movies'],
      schema: { Movies: { primary: 'Title', fields: [{ name: 'Year', required: false }, { name: 'Director', required: false }] } },
      items: { x: { id: 'x', cat: 'Movies', title: 'Heat', fields: { Year: '1995', Director: 'Michael Mann' }, elo: 1000, wins: 0, losses: 0 } },
    });
    assert.deepEqual(out.items[key('Movies', 'Heat')].fields, { Year: '1995', Director: 'Michael Mann' });
  });

  test('v2 array schema is wrapped as { primary: "Title", fields }; v3 object schema is left alone', () => {
    const out = migrate({
      _meta: { dataSchemaVersion: 2 },
      cats: ['Books', 'Games'],
      schema: {
        Books: [{ name: 'Author', required: true }],
        Games: { primary: 'Name', fields: [{ name: 'Platform', required: false }] },
      },
      items: {},
    });
    assert.deepEqual(out.schema.Books, { primary: 'Title', fields: [{ name: 'Author', required: true }] });
    assert.deepEqual(out.schema.Games, { primary: 'Name', fields: [{ name: 'Platform', required: false }] });
  });

  test('v3 -> v4 remaps random ids to itemKey everywhere history references them', () => {
    const out = migrate({
      _meta: { dataSchemaVersion: 3 },
      cats: ['Movies'],
      schema: { Movies: { primary: 'Title', fields: [] } },
      items: {
        r1: { id: 'r1', cat: 'Movies', title: 'Heat', fields: {}, elo: 1016, wins: 1, losses: 0 },
        r2: { id: 'r2', cat: 'Movies', title: 'Ronin', fields: {}, elo: 984, wins: 0, losses: 1 },
      },
      history: [
        { type: 'standard', winner: { id: 'r1', title: 'Heat' }, loser: { id: 'r2', title: 'Ronin' } },
        { type: 'podium', updates: [{ wid: 'r1', lid: 'r2' }], podium: [{ id: 'r1', place: 1 }, { id: 'r2', place: 2 }] },
        { type: 'standard', winner: { id: 'gone', title: 'Deleted' }, loser: { id: 'r2', title: 'Ronin' } },
      ],
    });
    const heat = key('Movies', 'Heat'), ronin = key('Movies', 'Ronin');
    assert.deepEqual(Object.keys(out.items).sort(), [heat, ronin].sort());
    assert.equal(out.items[heat].id, heat, 'item.id matches its new key');
    const [std, pod, orphan] = out.history;
    assert.deepEqual([std.winner.id, std.loser.id], [heat, ronin]);
    assert.deepEqual(pod.updates, [{ wid: heat, lid: ronin }]);
    assert.deepEqual(pod.podium.map(p => p.id), [heat, ronin]);
    assert.equal(orphan.winner.id, 'gone', 'ids with no matching item are left as-is');
  });

  test('v5 -> v6 drops syncBase but keeps ratings and the matchLog tail as-is (2.0.1 regression)', () => {
    // 2.0.1 incident: resetting ratings and replaying matchLog wiped real history, because
    // a pre-v6 matchLog was only the tail since the last compaction, not the full history.
    const heat = key('Movies', 'Heat'), ronin = key('Movies', 'Ronin');
    const tail = [{ id: 'dA-1', cat: 'Movies', wid: heat, lid: ronin, ts: 1, seq: 1 }];
    const out = migrate({
      _meta: { dataSchemaVersion: 5 },
      cats: ['Movies'],
      schema: { Movies: { primary: 'Title', fields: [] } },
      items: {
        [heat]: { id: heat, cat: 'Movies', title: 'Heat', fields: {}, elo: 1240, wins: 20, losses: 2, updatedAt: 5 },
        [ronin]: { id: ronin, cat: 'Movies', title: 'Ronin', fields: {}, elo: 900, wins: 2, losses: 20, updatedAt: 5 },
      },
      syncBase: { id: 'b1', parentId: null, rev: 3, ts: 1, ratings: {}, ancestry: ['b0'] },
      matchLog: tail,
      settings: { smartPairMode: true, deviceId: 'dA', matchSeq: 1 },
    });
    assert.equal(out.syncBase, undefined);
    assert.deepEqual([out.items[heat].elo, out.items[heat].wins, out.items[heat].losses], [1240, 20, 2]);
    assert.deepEqual([out.items[ronin].elo, out.items[ronin].wins, out.items[ronin].losses], [900, 2, 20]);
    assert.deepEqual(out.matchLog, tail);
    assert.deepEqual(out.itemDeletes, []);
    assert.equal(out.lastSyncedServerTs, null);
  });
});

describe('migrateData: current-version data', () => {
  const currentState = () => {
    const s = app.get('freshState()');
    const heat = key('Movies', 'Heat');
    s.items[heat] = { id: heat, cat: 'Movies', title: 'Heat', fields: { Year: '1995' }, elo: 1016, wins: 1, losses: 0, hidden: false, updatedAt: 42 };
    s.matchLog = [{ id: s.settings.deviceId + '-1', cat: 'Movies', wid: heat, lid: 'x', ts: 7, seq: 1 }];
    s.itemDeletes = [{ itemId: 'iold', ts: 9, deviceId: s.settings.deviceId, title: 'Old', cat: 'Movies' }];
    s.settings.matchSeq = 1;
    s._meta = { appVersion: '2.14.0', dataSchemaVersion: app.get('DATA_SCHEMA_VERSION'), exportedAt: '2026-09-01T00:00:00.000Z' };
    return s;
  };

  test('passes items, matchLog, tombstones, and settings through untouched', () => {
    const input = currentState();
    const out = migrate(input);
    assert.deepEqual(out.items, input.items);
    assert.deepEqual(out.matchLog, input.matchLog);
    assert.deepEqual(out.itemDeletes, input.itemDeletes);
    assert.deepEqual(out.settings, input.settings);
  });

  test('is idempotent, and restamps _meta with the running app version but keeps exportedAt', () => {
    const once = migrate(currentState());
    const twice = migrate(once);
    assert.deepEqual(twice, once);
    assert.equal(once._meta.appVersion, app.get('APP_VERSION'));
    assert.equal(once._meta.exportedAt, '2026-09-01T00:00:00.000Z');
  });

  test('backfills missing optional collections and settings, keeping an existing deviceId', () => {
    const out = migrate({ _meta: { dataSchemaVersion: 6 }, cats: [], schema: {}, items: {}, settings: { deviceId: 'dKeep' } });
    for (const k of ['history', 'matchLog', 'itemDeletes', 'itemUndeletes', 'catDeletes', 'catUndeletes']) {
      assert.deepEqual(out[k], [], `${k} backfilled`);
    }
    assert.equal(out.lastSyncedServerTs, null);
    assert.equal(out.settings.deviceId, 'dKeep');
    assert.equal(out.settings.matchSeq, 0);
    assert.equal(out.settings.knownBaselineId, null);
  });

  test('generates a deviceId when settings are missing entirely', () => {
    const out = migrate({ _meta: { dataSchemaVersion: 6 }, cats: [], schema: {}, items: {} });
    assert.match(out.settings.deviceId, /^d[0-9a-z]+$/);
  });
});

describe('load()', () => {
  test('migrates old saved data from localStorage on startup', () => {
    const page = loadApp({
      saved: {
        cats: ['Movies'],
        items: { abc: { id: 'abc', cat: 'Movies', title: 'Heat', year: '1995', elo: 1100, wins: 3, losses: 1 } },
      },
    });
    try {
      const items = page.get('state.items');
      const id = page.call('itemKey', 'Movies', 'Heat');
      assert.deepEqual(items[id].fields, { Year: '1995' });
      assert.equal(items[id].elo, 1100);
      assert.equal(page.get('loadFailed'), null);
    } finally { page.close(); }
  });

  test('unreadable saved data pauses saving instead of being overwritten (2.16.1 regression)', () => {
    const corrupt = '{"items": CORRUPTED';
    const page = loadApp({ saved: corrupt });
    try {
      assert.equal(page.get('loadFailed.raw'), corrupt);
      assert.deepEqual(page.get('state.items'), {}, 'app starts empty so it is still usable');
      page.run('save()');
      assert.equal(page.window.localStorage.getItem('ranker-v1'), corrupt, 'save() must not touch the stored data');
    } finally { page.close(); }
  });
});

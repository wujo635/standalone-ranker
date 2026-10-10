// Randomized multi-device simulation (tests/simulation/engine.js). Two parts:
//
//  1. A fixed set of seeds over everyday actions that currently pass, so a change that
//     breaks sync consistency fails here. Wider random sweeps run outside `npm test`:
//     `npm run simulate -- --seeds 200` (see tests/simulation/explore.js).
//  2. Each finding of the simulation, shrunk to its minimal sequence of steps, marked
//     `todo` until it's fixed. Every scenario starts from the same baseline (device 0
//     adds Heat, Ronin and Thief and uploads; devices 1 and 2 pull) and ends with every
//     device fully synced before the invariants are checked. When a fix lands, drop its
//     `todo` so the scenario guards against regressions.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./simulation/engine');

const EVERYDAY = ['add', 'add', 'rename', 'editDirector', 'csvAdd', 'delete', 'vote', 'vote', 'vote', 'upload', 'upload', 'pull', 'pull'];
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const replay = steps => quiet(() => run({ seed: 0, steps0: steps }));
const ok = r => assert.deepEqual(r.failures, [], `after ${r.steps.length} steps:\n  ${r.failures.join('\n  ')}`);

describe('simulation: everyday actions across three devices', () => {
  for (const seed of [1, 2, 3, 5, 8, 9]) {
    test(`seed ${seed}`, async () => ok(await quiet(() => run({ seed, steps: 30, types: EVERYDAY }))));
  }
});

describe('simulation findings (minimal reproductions)', () => {
  const finding = (name, todo, steps) => test(name, { todo }, async () => ok(await replay(steps)));

  finding('a rename followed by turning identity on, on the same device, survives other devices adopting the flag',
    'adoption re-keys a pulled item from its title before the incoming title is applied, and mints a newer rename that reverts it',
    [{ type: 'rename', dev: 0, eid: 2 }, { type: 'identityOn', dev: 0 }]);

  finding('a rename on one device while another turns identity on leaves one copy',
    'two renames of the same old id fork; only one rename tombstone per id survives, so the other target is orphaned',
    [{ type: 'vote', dev: 2, a: 96, b: 28 }, { type: 'upload', dev: 2 }, { type: 'identityOn', dev: 0 }, { type: 'rename', dev: 2, eid: 1 }]);

  finding('a year edit while another device turns identity on leaves one copy',
    'same fork as above, through an identity value edit',
    [{ type: 'editYear', dev: 0, eid: 1 }, { type: 'identityOn', dev: 0 }, { type: 'identityOn', dev: 1 }]);

  finding('a delete on one device while another turns identity on stays deleted',
    "the identity re-key's rename tombstone is newer than the delete, so the item lives on under its new id",
    [{ type: 'delete', dev: 2, eid: 0 }, { type: 'identityOn', dev: 1 }]);

  finding('an Upload from a device without an identity flag keeps the flag in the cloud (2.18.6)', false,
    [{ type: 'identityOn', dev: 2 }, { type: 'upload', dev: 2 }, { type: 'upload', dev: 0 }, { type: 'pull', dev: 1 }]);

  finding("an Upload doesn't overwrite a newer cloud copy with an older pulled one",
    'upload re-sends pulled items (echo); a device that is behind overwrites the newer doc, and devices never agree again',
    [{ type: 'add', dev: 1, eid: 6 }, { type: 'upload', dev: 1 }, { type: 'delete', dev: 1, eid: 6 }, { type: 'pull', dev: 2 },
      { type: 'add', dev: 1, eid: 5 }, { type: 'upload', dev: 1 }, { type: 'upload', dev: 2 }]);

  finding('votes on a deleted item are not replayed onto a re-added item with the same id',
    'other devices apply the old matches to the re-added item; the device that re-added it starts it at 0-0',
    [{ type: 'add', dev: 0, eid: 3 }, { type: 'vote', dev: 0, a: 65, b: 72 }, { type: 'delete', dev: 0, eid: 3 },
      { type: 'csvAdd', dev: 0, eid: 4, director: 'Villeneuve' }]);

  finding('a plain Pull on a device that missed a reset keeps every device consistent',
    "the pull merges the reseed into the device's old state (stored ratings only seed new items), then lets it upload",
    [{ type: 'add', dev: 0, eid: 6 }, { type: 'vote', dev: 0, a: 97, b: 24 }, { type: 'reset', dev: 0 }, { type: 'stalePull', dev: 2 }]);

  finding('a year edit, identity on and a reset, then a plain Pull elsewhere, leaves one copy',
    'combination of the stale-pull and identity findings',
    [{ type: 'editYear', dev: 1, eid: 0 }, { type: 'identityOn', dev: 0 }, { type: 'reset', dev: 0 }, { type: 'stalePull', dev: 1 }]);
});

// Runs many seeds, each in its own process (jsdom pages are heavy), shrinks every
// failure to a minimal sequence of steps, and groups failures by kind.
//   node tests/simulation/explore.js [--seeds N] [--from S] [--steps N] [--types a,b] [--concurrent] [--seed S]
const { execFileSync } = require('node:child_process');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : process.argv[i + 1]; };
const flag = name => process.argv.includes('--' + name);
const opts = { steps: Number(arg('steps', 40)), concurrent: flag('concurrent'), types: arg('types', null)?.split(',') };

if (flag('worker')) {
  const { run, shrink } = require('./engine');
  console.log = () => {}; // the app's toasts
  (async () => {
    const o = { seed: Number(arg('seed')), steps: opts.steps, concurrent: opts.concurrent, ...(opts.types ? { types: opts.types } : {}) };
    const r = await run(o);
    const out = r.failures.length ? await shrink(r, o) : r;
    process.stdout.write('\n@@' + JSON.stringify({ failures: out.failures, steps: out.steps }));
  })().catch(e => { process.stdout.write('\n@@' + JSON.stringify({ failures: ['crash: ' + e.stack.split('\n').slice(0, 3).join(' ')], steps: [] })); });
} else {
  const seeds = arg('seed', null) ? [Number(arg('seed'))] : Array.from({ length: Number(arg('seeds', 50)) }, (_, i) => Number(arg('from', 1)) + i);
  const byKind = {};
  const pass = process.argv.slice(2).filter(a => a !== '--seeds' && a !== '--from');
  for (const seed of seeds) {
    const args = [__filename, '--worker', '--seed', String(seed), '--steps', String(opts.steps)];
    if (opts.types) args.push('--types', opts.types.join(','));
    if (opts.concurrent) args.push('--concurrent');
    const raw = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
    const r = JSON.parse(raw.slice(raw.lastIndexOf('@@') + 2));
    if (!r.failures.length) continue;
    const kind = r.failures[0].split(':')[0] + ':' + r.failures[0].split(':').slice(1).join(':').replace(/\b(i[0-9a-z]{5,9}|\d+)\b/g, '#').replace(/\{.*$/, '').slice(0, 70);
    (byKind[kind] = byKind[kind] || []).push(seed);
    if (byKind[kind].length === 1 || seeds.length === 1) {
      console.log(`\n=== seed ${seed}: ${r.failures[0].slice(0, 400)}`);
      r.steps.forEach((s, i) => console.log(`  ${i + 1}. ${JSON.stringify(s)}`));
    }
  }
  console.log('\n=== summary:', seeds.length, 'seeds');
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(v.length).padStart(3)}x ${k}  (seeds ${v.slice(0, 6).join(',')})`);
}

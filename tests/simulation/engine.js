// Randomized multi-device simulation of the sync model. Drives several real app pages
// (loadApp()) against one in-memory Firestore through the same functions the UI calls,
// interleaving random user actions and sync steps, and keeps its own record of what the
// library *should* contain (the "model"). After every step, and again once every device
// has fully synced, it checks invariants that must hold no matter the order of events:
//
//   on-schema    every item's id is the one its title and identity fields give
//   balanced     each device's total wins equal its total losses
//   converged    after a full sync, every device holds the same items, fields, W/L and
//                identity flags
//   complete     every film the model says is alive is on every device, exactly once
//   no-merge     every item is one film; nothing deleted comes back
//   counted      each film's W/L equals the votes on it that should count
//
// Steps are plain data ({ type, dev, ... }) so a failing run can be replayed and shrunk
// (see shrink()). A step whose precondition doesn't hold when replayed is skipped.
//
// Behaviour documented as an accepted tradeoff in ARCHITECTURE.md ("Known gaps in the
// merge model") is not reported: ELO may drift between devices (W/L may not), field
// edits are last-write-wins per item, and a match against a since-deleted item can leave
// its opponent's W/L off by one. Concurrent edits of the same film on two devices are
// only generated when opts.concurrent is set.
const { loadApp } = require('../helpers/app');
const { createFirestore, connect } = require('../helpers/firestore');

const CAT = 'Movies';
// Two pairs share a title (Superman, Dune): they can only coexist with Year as identity.
const POOL = [['Heat', '1995'], ['Ronin', '1998'], ['Thief', '1981'], ['Superman', '1978'], ['Superman', '2025'], ['Dune', '1984'], ['Dune', '2021']];
const DEFAULT_TYPES = ['add', 'add', 'rename', 'editYear', 'editDirector', 'csvAdd', 'delete', 'vote', 'vote', 'vote',
  'upload', 'upload', 'pull', 'pull', 'identityOn', 'reset', 'adopt', 'stalePull'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class Sim {
  constructor(opts = {}) {
    this.opts = { devices: 3, types: DEFAULT_TYPES, concurrent: false, ...opts };
    this.db = createFirestore();
    this.clock = 1_800_000_000_000;
    this.devs = [];
    for (let d = 0; d < this.opts.devices; d++) {
      const app = loadApp();
      connect(app, this.db, { email: `d${d}@example.com` });
      app.run(`state.settings.deviceId = 'dev${d}'`);
      // One shared, strictly increasing clock: real actions are seconds apart, so
      // same-millisecond ties (a different, unrealistic class of bug) never happen.
      app.window.Date.now = () => this.clock;
      this.devs.push({ app, seen: 0, adoptedSinceReset: true });
    }
    this.cloudVersion = 0;       // bumped by every successful upload or reset
    this.resetCount = 0;
    this.entities = POOL.map(([title, year], eid) => ({
      eid, base: { title, year }, cur: null, pub: null, pending: new Set(),
      names: new Set([key(title, year)]), gen: 0, tainted: false, everDeleted: false,
    }));
    this.votes = [];
    this.flags = { stalePull: false, deleted: false };
    this.log = [];
    this.renameSeq = 0;
  }

  close() { this.devs.forEach(d => d.app.close()); }
  tick() { this.clock += 1000; }

  // --- reading the app ---------------------------------------------------------
  items(d) { return Object.values(this.devs[d].app.get('state.items')).filter(i => i.cat === CAT); }
  identityOn(d) { return !!this.devs[d].app.get(`(state.schema[${JSON.stringify(CAT)}]?.fields || []).find(f => f.name === 'Year')?.identity`); }
  entityOfItem(item) {
    const k = key(item.title, item.fields?.Year || '');
    return this.entities.find(e => e.names.has(k));
  }
  itemOf(d, e) {
    if (!e.cur) return null;
    return this.items(d).find(i => i.title === e.cur.title && (i.fields?.Year || '') === e.cur.year) || null;
  }
  fresh(d) { return this.devs[d].seen === this.cloudVersion && this.devs[d].adoptedSinceReset; }
  canMutate(d, e) { return this.fresh(d) && (this.opts.concurrent || [...e.pending].every(x => x === d)); }

  // --- steps -------------------------------------------------------------------
  // Picks a random applicable step (or null).
  generate(rand) {
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    for (let tries = 0; tries < 30; tries++) {
      const type = pick(this.opts.types);
      const dev = Math.floor(rand() * this.devs.length);
      const step = { type, dev };
      if (['add', 'csvAdd'].includes(type)) step.eid = pick(this.entities).eid;
      if (['rename', 'editYear', 'editDirector', 'delete'].includes(type)) step.eid = pick(this.entities).eid;
      if (type === 'csvAdd') step.director = pick(['', 'Mann', 'Villeneuve']);
      if (type === 'editDirector') step.director = pick(['Mann', 'Donner', 'Gunn', 'Lynch']);
      if (type === 'vote') { step.a = Math.floor(rand() * 100); step.b = Math.floor(rand() * 100); }
      if (this.applicable(step)) return step;
    }
    return null;
  }

  applicable(s) {
    const e = s.eid !== undefined ? this.entities[s.eid] : null;
    switch (s.type) {
      case 'add': case 'csvAdd':
        if (e.cur || !this.canMutate(s.dev, e)) return s.type === 'csvAdd' && !!e.cur && this.canMutate(s.dev, e) && !!this.itemOf(s.dev, e);
        // A second film with the same title is only distinguishable with Year as identity.
        if (this.identityOn(s.dev)) return true;
        if (this.entities.some(o => o !== e && o.cur && o.cur.title === e.base.title)) return false;
        // Without identity, same-titled films share one id. Re-adding it while another
        // device's delete of that id is unsent loses to the delete (documented gap).
        return !this.entities.some(o => o.base.title === e.base.title && [...o.pending].some(p => p !== s.dev));
      case 'rename': case 'editDirector': case 'delete':
        return !!e.cur && this.canMutate(s.dev, e) && !!this.itemOf(s.dev, e);
      case 'editYear':
        return !!e.cur && this.canMutate(s.dev, e) && !!this.itemOf(s.dev, e) && !this.entities.some(o => o !== e && o.cur && o.cur.title === e.cur.title);
      case 'vote': return this.items(s.dev).length >= 2;
      case 'reset': return this.fresh(s.dev);
      case 'adopt': return this.resetCount > 0;
      case 'stalePull': return !this.devs[s.dev].adoptedSinceReset;
      default: return true;
    }
  }

  // Runs one step against the app and updates the model. Returns false if skipped.
  async exec(s) {
    if (!this.applicable(s)) return false;
    this.tick();
    const d = s.dev, dv = this.devs[d], app = dv.app;
    const e = s.eid !== undefined ? this.entities[s.eid] : null;
    const doc = app.window.document;
    const libraryOn = () => app.run(`document.getElementById('sel-cat').value = ${JSON.stringify(CAT)}; onLibCatChange();`);
    switch (s.type) {
      case 'add': {
        if (e.cur) return false;
        libraryOn();
        doc.getElementById('inp-primary').value = e.base.title;
        doc.getElementById('field-Year').value = e.base.year;
        doc.getElementById('field-Director').value = '';
        app.run('addItem()');
        if (!this.items(d).some(i => i.title === e.base.title && i.fields.Year === e.base.year)) return this.note(s, 'rejected by app');
        this.created(e, d, { title: e.base.title, year: e.base.year, director: '' });
        break;
      }
      case 'csvAdd': {
        const target = e.cur || { title: e.base.title, year: e.base.year };
        app.run(`bulkAddCSVImport({ category: ${JSON.stringify(CAT)}, items: [{ title: ${JSON.stringify(target.title)}, fields: { Year: ${JSON.stringify(target.year)}, Director: ${JSON.stringify(s.director)} } }] })`);
        if (!this.items(d).some(i => i.title === target.title && i.fields.Year === target.year)) return this.note(s, 'rejected by app');
        if (e.cur) this.mutated(e, d, { ...e.cur, director: s.director });
        else this.created(e, d, { title: target.title, year: target.year, director: s.director });
        break;
      }
      case 'rename': case 'editYear': case 'editDirector': {
        const item = this.itemOf(d, e);
        const next = { ...e.cur };
        if (s.type === 'rename') next.title = `${e.base.title} #${++this.renameSeq}`;
        if (s.type === 'editYear') next.year = String(Number(e.cur.year) + 1);
        if (s.type === 'editDirector') next.director = s.director;
        libraryOn();
        app.run(`renderLibrary(); editItem(${JSON.stringify(item.id)});`);
        doc.getElementById('edit-primary-' + item.id).value = next.title;
        doc.getElementById(`edit-field-${item.id}-Year`).value = next.year;
        doc.getElementById(`edit-field-${item.id}-Director`).value = next.director;
        app.run(`saveItem(${JSON.stringify(item.id)})`);
        if (!this.items(d).some(i => i.title === next.title && i.fields.Year === next.year)) return this.note(s, 'rejected by app');
        e.names.add(key(next.title, next.year));
        this.mutated(e, d, next);
        break;
      }
      case 'delete': {
        const item = this.itemOf(d, e);
        app.run(`deleteItem(${JSON.stringify(item.id)})`);
        e.everDeleted = true;
        this.votes.forEach(v => {
          if (v.w === e.eid && v.wGen === e.gen) this.entities[v.l].tainted = true;
          if (v.l === e.eid && v.lGen === e.gen) this.entities[v.w].tainted = true;
        });
        this.flags.deleted = true;
        this.mutated(e, d, null);
        break;
      }
      case 'vote': {
        const its = this.items(d).sort((x, y) => x.id.localeCompare(y.id));
        const w = its[s.a % its.length], l = its[(s.a + 1 + (s.b % (its.length - 1))) % its.length];
        if (!w || !l || w.id === l.id) return false;
        app.run(`eloUpdate(state.items[${JSON.stringify(w.id)}], state.items[${JSON.stringify(l.id)}]); recordMatch(${JSON.stringify(CAT)}, ${JSON.stringify(w.id)}, ${JSON.stringify(l.id)});`);
        const we = this.entityOfItem(w), le = this.entityOfItem(l);
        // A vote cast on a copy the model can't attribute, or by a device that may hold a
        // previous incarnation of a deleted film, is outside what the W/L check models.
        const stale = !this.fresh(d);
        [we, le].forEach(x => { if (!x || !x.cur || (stale && x.everDeleted)) { if (x) x.tainted = true; } });
        // Documented gap: a vote involving a film another device already deleted leaves the
        // opponent's W/L off by one between devices.
        if (we && !we.cur && le) le.tainted = true;
        if (le && !le.cur && we) we.tainted = true;
        if (we && le) this.votes.push({ dev: d, w: we.eid, l: le.eid, wGen: we.gen, lGen: le.gen, uploaded: false, dropped: false });
        else [we, le].forEach(x => x && (x.tainted = true));
        break;
      }
      case 'identityOn': case 'identityOff': {
        const want = s.type === 'identityOn';
        if (this.identityOn(d) === want) return false;
        app.run(`document.getElementById('sel-cat').value = ${JSON.stringify(CAT)}; openSchemaEditor();`);
        const row = [...doc.querySelectorAll('#schema-fields .field-row')].find(r => r.querySelector('.field-name').textContent === 'Year');
        row.querySelector('[data-action="toggleIdentity"]').click();
        [...doc.querySelectorAll('#view-schema button')].find(b => b.textContent.trim().startsWith('Save')).click();
        if (this.identityOn(d) !== want) return this.note(s, 'rejected by app');
        break;
      }
      case 'upload': {
        const ok = await this.cloud(d, 'uploadToFirestore()');
        if (!ok) return this.note(s, 'refused');
        this.uploaded(d);
        break;
      }
      case 'pull': case 'stalePull': {
        if (s.type === 'pull' && !dv.adoptedSinceReset) return false; // see stalePull
        if (s.type === 'stalePull') this.flags.stalePull = true;
        await this.cloud(d, 'pullFromFirestore()');
        dv.seen = this.cloudVersion;
        if (s.type === 'stalePull') dv.adoptedSinceReset = true; // the app now lets it upload
        break;
      }
      case 'reset': {
        if (!(await this.cloud(d, 'resetSharedBaseline()'))) return this.note(s, 'failed');
        this.resetCount++;
        // The reseed is this device's view: everything published, plus its own pending work.
        this.entities.forEach(x => {
          if ([...x.pending].some(p => p !== d)) return; // others' unsent work is lost when they adopt
          x.pub = x.cur ? { ...x.cur } : null; x.pending.delete(d);
        });
        this.votes.forEach(v => { if (v.dev === d && !v.dropped) v.uploaded = true; });
        this.cloudVersion++;
        this.devs.forEach((o, i) => { o.adoptedSinceReset = i === d; });
        dv.seen = this.cloudVersion;
        break;
      }
      case 'adopt': {
        await this.cloud(d, 'adoptFreshBaseline()');
        // Adopt erases this device's unsent votes and edits; the cloud version stands.
        this.votes.forEach(v => { if (v.dev === d && !v.uploaded) v.dropped = true; });
        this.entities.forEach(x => {
          if (!x.pending.has(d)) return;
          x.pending.delete(d);
          x.cur = x.pub ? { ...x.pub } : null;
          if (!x.cur) x.gen++;
        });
        dv.adoptedSinceReset = true;
        dv.seen = this.cloudVersion;
        break;
      }
      default: throw new Error('unknown step ' + s.type);
    }
    this.log.push(s);
    return true;
  }

  note(s, why) { s.skipped = why; return false; }
  created(e, d, cur) { e.cur = cur; e.gen++; e.pending.add(d); }
  mutated(e, d, cur) { e.cur = cur; e.pending.add(d); }
  uploaded(d) {
    const dv = this.devs[d];
    this.votes.forEach(v => { if (v.dev === d && !v.dropped) v.uploaded = true; });
    this.entities.forEach(x => { if (x.pending.has(d)) { x.pending.delete(d); if (!x.pending.size) x.pub = x.cur ? { ...x.cur } : null; } });
    const wasFresh = dv.seen === this.cloudVersion;
    this.cloudVersion++;
    if (wasFresh) dv.seen = this.cloudVersion;
  }
  // The app's cloud functions return true/false (or undefined); only false is failure.
  async cloud(d, call) { return (await this.devs[d].app.window.eval(call)) !== false; }

  // --- invariants --------------------------------------------------------------
  // Checked after every step: every device stays on-schema and balanced.
  checkStep() {
    const out = [];
    this.devs.forEach((dv, d) => {
      const off = dv.app.get(`Object.values(state.items).filter(i => i.id !== itemKey(i.cat, i.title, identitySuffixFor(i.cat, i.fields))).map(i => i.title + ' (' + (i.fields.Year || '') + ') ' + i.id)`);
      if (off.length) out.push(`on-schema: device ${d} has ${off.length} item(s) off their id: ${off.slice(0, 3).join(', ')}`);
      const its = this.items(d);
      const w = its.reduce((a, i) => a + (i.wins || 0), 0), l = its.reduce((a, i) => a + (i.losses || 0), 0);
      if (w !== l && !this.flags.deleted) out.push(`balanced: device ${d} has ${w} wins vs ${l} losses`);
      if (dv.app.scriptErrors.length) out.push(`script error on device ${d}: ${dv.app.scriptErrors[0].message}`);
    });
    return out;
  }

  // Brings every device up to date the way a careful user would, then checks the rest.
  async converge() {
    for (let round = 0; round < 2; round++) {
      for (let d = 0; d < this.devs.length; d++) {
        this.tick();
        if (!this.devs[d].adoptedSinceReset) await this.exec({ type: 'adopt', dev: d });
        else { await this.exec({ type: 'pull', dev: d }); await this.exec({ type: 'upload', dev: d }); }
      }
    }
    for (let d = 0; d < this.devs.length; d++) await this.exec({ type: 'pull', dev: d });
    return this.checkConverged();
  }

  checkConverged() {
    const out = [...this.checkStep()];
    const wl = i => { const e = this.entityOfItem(i); return e && e.tainted ? {} : { wins: i.wins, losses: i.losses }; };
    const view = d => this.items(d).map(i => ({ id: i.id, title: i.title, Year: i.fields.Year || '', Director: i.fields.Director || '', ...wl(i) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const ref = JSON.stringify(view(0));
    for (let d = 1; d < this.devs.length; d++) {
      const v = JSON.stringify(view(d));
      if (v !== ref) out.push(`converged: device ${d} differs from device 0: ${diff(view(0), view(d))}`);
      if (this.identityOn(d) !== this.identityOn(0)) out.push(`converged: Year identity is ${this.identityOn(d)} on device ${d} but ${this.identityOn(0)} on device 0`);
    }
    this.devs.forEach((dv, d) => {
      const its = this.items(d);
      for (const e of this.entities) {
        const copies = its.filter(i => this.entityOfItem(i) === e);
        if (e.cur && copies.length === 0) out.push(`complete: device ${d} lost ${e.cur.title} (${e.cur.year})`);
        if (copies.length > 1) out.push(`complete: device ${d} has ${copies.length} copies of ${e.base.title} (${e.base.year}): ${copies.map(c => c.id + ' ' + c.title + ' ' + c.fields.Year).join(', ')}`);
        if (!e.cur && copies.length) out.push(`no-merge: device ${d} still has deleted ${copies[0].title} (${copies[0].fields.Year})`);
        if (e.cur && copies.length === 1 && (copies[0].title !== e.cur.title || (copies[0].fields.Year || '') !== e.cur.year)) out.push(`no-merge: device ${d} has ${e.base.title} as ${copies[0].title} (${copies[0].fields.Year}), expected ${e.cur.title} (${e.cur.year})`);
        if (e.cur && copies.length === 1 && !e.tainted && !this.flags.stalePull) {
          const counted = v => !v.dropped;
          const wins = this.votes.filter(v => counted(v) && v.w === e.eid && v.wGen === e.gen).length;
          const losses = this.votes.filter(v => counted(v) && v.l === e.eid && v.lGen === e.gen).length;
          if (copies[0].wins !== wins || copies[0].losses !== losses) out.push(`counted: device ${d} has ${e.cur.title} (${e.cur.year}) at ${copies[0].wins}-${copies[0].losses}, expected ${wins}-${losses}`);
        }
      }
      const strays = its.filter(i => !this.entityOfItem(i));
      if (strays.length) out.push(`no-merge: device ${d} has item(s) matching no film: ${strays.map(i => i.title + ' (' + i.fields.Year + ')').join(', ')}`);
    });
    return [...new Set(out)];
  }
}

function key(title, year) { return String(title).trim().toLowerCase() + '|' + String(year || '').trim().toLowerCase(); }
function diff(a, b) {
  const A = new Map(a.map(x => [x.id, x])), B = new Map(b.map(x => [x.id, x]));
  const parts = [];
  for (const [id, x] of A) if (!B.has(id)) parts.push(`missing ${x.title} (${x.Year}) ${id}`); else if (JSON.stringify(x) !== JSON.stringify(B.get(id))) parts.push(`${x.title}: ${JSON.stringify(x)} vs ${JSON.stringify(B.get(id))}`);
  for (const [id, x] of B) if (!A.has(id)) parts.push(`extra ${x.title} (${x.Year}) ${id}`);
  return parts.slice(0, 4).join('; ');
}

// Runs one seeded scenario. Returns { failures, steps, failedAt }.
async function run({ seed, steps = 40, steps0 = null, ...opts }) {
  const sim = new Sim(opts);
  try {
    // Baseline: device 0 adds three films and uploads; the others pull.
    const setup = [0, 1, 2].map(eid => ({ type: 'add', dev: 0, eid })).concat([{ type: 'upload', dev: 0 }],
      sim.devs.slice(1).map((_, i) => ({ type: 'pull', dev: i + 1 })));
    for (const s of setup) await sim.exec(s);
    const rand = mulberry32(seed);
    const plan = steps0 || [];
    const executed = [];
    for (let n = 0; steps0 ? n < plan.length : n < steps; n++) {
      const s = steps0 ? { ...plan[n] } : sim.generate(rand);
      if (!s) continue;
      const ran = await sim.exec(s);
      if (ran) executed.push(stripSkip(s));
      const f = sim.checkStep();
      if (f.length) return { failures: f, steps: executed, failedAt: executed.length };
    }
    const f = await sim.converge();
    return { failures: f, steps: executed, failedAt: f.length ? 'converge' : null };
  } finally { sim.close(); }
}
const stripSkip = s => { const c = { ...s }; delete c.skipped; return c; };

// Delta-debugging: drops steps while the run still fails with the same first invariant.
async function shrink(result, opts) {
  const sig = f => f[0].split(':')[0];
  const target = sig(result.failures);
  let steps = result.steps;
  let best = result;
  let chunk = Math.ceil(steps.length / 2);
  while (chunk >= 1) {
    let progressed = false;
    for (let i = 0; i < steps.length; i += chunk) {
      const candidate = steps.slice(0, i).concat(steps.slice(i + chunk));
      const r = await run({ ...opts, steps0: candidate });
      if (r.failures.length && sig(r.failures) === target) { steps = r.steps; best = r; progressed = true; i -= chunk; }
    }
    if (!progressed) chunk = Math.floor(chunk / 2);
  }
  return best;
}

module.exports = { run, shrink, Sim, POOL, DEFAULT_TYPES };

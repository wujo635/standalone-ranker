// Loads the real index.html into jsdom and exposes a small API for driving it from
// node:test. The app is a single inline <script>, so this exercises exactly the code
// that ships — no extraction, no copies. External <script src> tags (the Firebase CDN)
// are never fetched by jsdom, so `firebase` is undefined and the app takes its normal
// "cloud sync unavailable" path.
//
// Each loadApp() call builds a brand-new page, so module-level variables (state,
// fieldTypeCache, loadFailed, ...) never leak between tests. Call close() when done so
// the page's timers (e.g. toast's hide timer) don't keep the test process alive.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

// `beforeScript(window)` runs before the app's script, e.g. to install a fake `firebase`
// global (see fakeFirebase() in ./firestore.js) so the app's own cloud startup runs.
//
// jsdom has no IndexedDB, so by default the app stores in localStorage, as a browser
// without IndexedDB does. `idb` installs one (an IDBFactory from fake-indexeddb, 2.25.0);
// pass the same factory to the next loadApp() to model a reload in the same browser, with
// `storage` carrying that browser's localStorage entries over (app.localStorage()). With
// IndexedDB the app loads asynchronously: await app.ready() before reading state.
function loadApp({ saved, beforeScript, idb, storage } = {}) {
  const scriptErrors = [];
  const virtualConsole = new VirtualConsole();
  // Uncaught errors thrown by the page's own script arrive as "jsdomError". The app's
  // console.log/console.error output (toasts, deliberate [load]/[save] logs) is dropped.
  virtualConsole.on('jsdomError', e => scriptErrors.push(e));

  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      // jsdom has no IntersectionObserver; the Leaderboard's infinite scroll constructs
      // one whenever a category has more rows than one batch. A no-op stand-in keeps
      // renderLB() working; tests load more rows via Show all instead of scrolling.
      if (!window.IntersectionObserver) {
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      }
      // Seeds localStorage before the app's script runs, so load() sees it on startup.
      Object.entries(storage || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
      if (idb) window.indexedDB = idb;
      if (saved !== undefined) {
        window.localStorage.setItem('ranker-v1', typeof saved === 'string' ? saved : JSON.stringify(saved));
      }
      if (beforeScript) beforeScript(window);
    },
  });
  const { window } = dom;

  // Everything crossing the page boundary goes through JSON. Objects created inside
  // jsdom belong to a different JS realm (their own Object.prototype), which makes
  // assert.deepStrictEqual fail on values that are otherwise identical — and going
  // in, JSON mirrors how real data reaches the app anyway (file import, localStorage).
  const fromPage = json => (json === undefined ? undefined : JSON.parse(json));
  const app = {
    window,
    scriptErrors,
    // Evaluates an expression in the page's global scope (which sees its top-level
    // let/const bindings like `state`) and returns a plain copy of the result.
    get(expr) { return fromPage(window.eval(`JSON.stringify(${expr})`)); },
    // Runs statements in the page; returns nothing.
    run(code) { window.eval(code); },
    // Calls a page function by name with JSON-serializable arguments.
    call(fnName, ...args) {
      return fromPage(window.eval(`JSON.stringify(${fnName}(...${JSON.stringify(args)}))`));
    },
    // Replaces the page's `state` wholesale (e.g. with a freshState() tweaked in Node).
    setState(obj) { window.eval(`state = ${JSON.stringify(obj)}`); },
    // Resolves once the app's load() has finished (immediate without IndexedDB).
    ready() { return window.eval('appReady'); },
    // This page's localStorage as a plain object, to carry into a reload.
    localStorage() {
      const out = {};
      for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); out[k] = window.localStorage.getItem(k); }
      return out;
    },
    close() { window.close(); },
  };

  if (scriptErrors.length) {
    app.close();
    throw scriptErrors[0];
  }
  return app;
}

module.exports = { loadApp };

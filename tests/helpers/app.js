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

function loadApp({ saved } = {}) {
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
      // Seeds localStorage before the app's script runs, so load() sees it on startup.
      if (saved !== undefined) {
        window.localStorage.setItem('ranker-v1', typeof saved === 'string' ? saved : JSON.stringify(saved));
      }
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
    close() { window.close(); },
  };

  if (scriptErrors.length) {
    app.close();
    throw scriptErrors[0];
  }
  return app;
}

module.exports = { loadApp };

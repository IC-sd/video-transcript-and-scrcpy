const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function context(extra = {}) {
  const c = vm.createContext({ URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Response,
    setTimeout, clearTimeout, console, Intl, ...extra });
  c.self = c;
  c.window = c;
  return c;
}
function load(c, file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), c, { filename: file });
  return c;
}
function contentContext(fetch, url = 'https://www.bilibili.com/video/BV1234567890') {
  const listeners = [];
  const location = new URL(url);
  const c = context({ fetch, location,
    document: { title: '测试视频', querySelectorAll: () => [], querySelector: () => null,
      getElementById: () => null, documentElement: { dataset: {} } },
    addEventListener() {},
    chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: async () => ({ ok: false, error: 'CDN failed' }) } },
  });
  load(c, 'lib/core.js'); load(c, 'content.js');
  const send = (message) => new Promise((resolve) => listeners[0](message, {}, resolve));
  return { c, listeners, send };
}
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
module.exports = { context, load, contentContext, json };

/**
 * inject_hook.js —— 在 YouTube 页面的主世界（MAIN world）里运行。
 *
 * 背景：WEB client 的字幕地址裸请求会返回 200 + 0 字节（POT 防绕过），
 * 但播放器**自己**请求字幕时带的上下文（POT、签名等）是完整的。
 * 所以最可靠的办法是：在页面里守着，播放器一发出 timedtext 请求就记下地址，
 * 扩展随后用同一个地址（把 fmt 换成 json3）重新取一次。
 *
 * 必须以 world: "MAIN" + document_start 注入，才能赶在播放器发请求之前 hook 住。
 * 捕获结果同时写 DOM dataset 和 postMessage —— content script 是 document_idle
 * 才注入的，早期捕获若只走 postMessage 会丢，DOM 通道保证不漏。
 */
(function () {
  'use strict';
  if (window.__biliTxHook) return;
  window.__biliTxHook = true;

  const seen = new Set();
  const captured = [];

  function flushDom() {
    try {
      document.documentElement.dataset.biliTxUrls = JSON.stringify(captured.slice(-20));
    } catch (e) { /* dataset 写入失败不影响主流程 */ }
  }

  function capture(raw) {
    try {
      const parsed = new URL(raw, location.href);
      if (parsed.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com'].includes(parsed.hostname)
          || parsed.pathname !== '/api/timedtext') return;
      const u = parsed.href;
      // 去掉 fmt（扩展会自己换成 json3），其余签名/POT 参数原样保留
      const clean = u.replace(/([?&])fmt=[^&]*/, '$1').replace(/&&+/g, '&').replace(/[?&]$/, '');
      if (seen.has(clean)) return;
      seen.add(clean);
      captured.push({ url: clean, at: Date.now() });
      if (captured.length > 20) seen.delete(captured.shift().url);
      flushDom();
      window.postMessage({ source: 'bili-tx-hook', type: 'timedtext', url: clean, at: Date.now() }, '*');
    } catch (e) { /* 忽略非字幕请求的异常 */ }
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      try {
        const a = args[0];
        capture(typeof a === 'string' || a instanceof URL ? String(a) : (a && a.url) || '');
      } catch (e) { /* ignore */ }
      return origFetch.apply(this, args);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { capture(url); } catch (e) { /* ignore */ }
    return origOpen.apply(this, [method, url, ...rest]);
  };
})();

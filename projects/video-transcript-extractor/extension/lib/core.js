/** Shared URL, filename and request helpers. No browser API dependency. */
(function (global) {
  'use strict';
  function platform(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.port || u.username || u.password) return '';
      if (u.hostname === 'www.bilibili.com' && /^\/(video|list|bangumi\/play)\//.test(u.pathname)) return 'bilibili';
      if (['www.youtube.com', 'm.youtube.com'].includes(u.hostname)
          && ((u.pathname === '/watch' && u.searchParams.get('v')) || /^\/shorts\/[^/]+/.test(u.pathname))) return 'youtube';
    } catch (_) { /* invalid URL */ }
    return '';
  }
  function subtitleUrl(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' && !u.port && !u.username && !u.password
        && ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'youtube.com']
          .some((host) => u.hostname === host || u.hostname.endsWith('.' + host));
    } catch (_) { return false; }
  }
  function safeName(raw) {
    let name = String(raw || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/g, '');
    if (!name || /^\.+$/.test(name)) name = '视频';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }
  function cleanDir(raw) {
    return String(raw || '').replace(/\\/g, '/').split('/')
      .filter((p) => p.trim() && !/^\.+$/.test(p.trim()))
      .map(safeName).join('/');
  }
  async function request(url, opts, format = 'text', timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...opts, signal: controller.signal });
      if (!response.ok) throw new Error('请求失败 HTTP ' + response.status);
      return await response[format]();
    } catch (e) {
      if (controller.signal.aborted) throw new Error('请求超时，请检查网络后重试');
      throw e;
    } finally { clearTimeout(timer); }
  }
  global.BiliCore = { platform, subtitleUrl, safeName, cleanDir, request };
})(typeof window !== 'undefined' ? window : self);

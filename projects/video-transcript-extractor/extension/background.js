/**
 * background.js —— 只做两件事：初始化默认设置、给 popup 提供当前页信息。
 * 文件下载放在结果页里做（service worker 里没有 DOM，拿不到 Blob URL）。
 */

importScripts('lib/core.js');

// Content scripts do not need settings; keep API keys in trusted extension contexts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

const DEFAULT_SETTINGS = {
  // 转录文字
  transcriptSave: false,
  transcriptMode: 'sub',      // dir=固定文件夹 / ask=每次询问 / sub=下载目录子目录
  transcriptDir: '字幕',
  // AI 总结
  aiSave: false,
  aiMode: 'sub',
  aiDir: '总结',
  // 提取选项默认值
  allParts: false,
  withTimestamp: true,
  termFixes: '',
  ai: { baseUrl: '', apiKey: '', model: '' },
};

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(cur.settings || {}) };
  await chrome.storage.local.set({ settings: merged });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 字幕文件放在 hdslb.com 这类 CDN 上，页面里直接取会被 CORS 拦；
  // 后台脚本有 host_permissions，不受 CORS 限制，因此由这里代取。
  if (msg && msg.type === 'FETCH_TEXT') {
    if (sender.id !== chrome.runtime.id || !BiliCore.subtitleUrl(msg.url)) {
      sendResponse({ ok: false, error: '字幕地址不受支持' });
      return false;
    }
    BiliCore.request(msg.url, { credentials: 'include', cache: 'no-store', redirect: 'error' })
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  return false;
});

/** Load the real unpacked extension in a disposable browser profile. */
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const extension = path.resolve(__dirname, '../extension');
  const profile = path.resolve(process.env.TEST_PROFILE || path.join(__dirname, '../.test-artifacts/profile'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = worker.url().split('/')[2];
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + id + '/options.html');
    await page.locator('#aiKey').waitFor();
    await page.locator('#withTimestamp').uncheck();
    await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.withTimestamp === false);
    await page.evaluate(async () => {
      await chrome.storage.session.set({ 'result:smoke': {
        data: { title: '扩展实装测试', platform: 'bilibili', uploader: '测试', durationText: '00:10', chars: 8,
          partTotal: 1, partGot: 1, markdown: '# 测试\n---\n内容', text: '这是测试文稿。', items: [], missing: [] },
        opts: { withTs: false }, mode: 'transcript', createdAt: Date.now(),
      } });
    });
    await page.goto('chrome-extension://' + id + '/result.html?id=smoke');
    await page.locator('#docC h1').waitFor();
    assert.equal(await page.locator('#ttl').textContent(), '扩展实装测试');
    assert.match(await page.locator('#docT').textContent(), /这是测试文稿/);
    const denied = await page.evaluate(async () => chrome.runtime.sendMessage({ type: 'FETCH_TEXT', url: 'https://example.com/private' }));
    assert.equal(denied.ok, false);

    // Exercise the actual isolated-world content script with deterministic site responses.
    const cors = { 'Access-Control-Allow-Origin': 'https://www.bilibili.com', 'Access-Control-Allow-Credentials': 'true' };
    await context.route('https://www.bilibili.com/video/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html><title>测试视频</title><body>视频页</body></html>',
    }));
    await context.route('https://api.bilibili.com/**', (route) => {
      const view = route.request().url().includes('/view?');
      const data = view
        ? { code: 0, data: { title: '模拟站点视频', owner: { name: '测试' }, duration: 10, pages: [{ page: 1, cid: 123, part: '正文' }] } }
        : { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://i0.hdslb.com/fixture.json' }] } } };
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(data) });
    });
    await context.route('https://i0.hdslb.com/fixture.json', (route) => route.fulfill({
      contentType: 'application/json', headers: cors,
      body: JSON.stringify({ body: [{ from: 0, to: 2, content: '这是来自真实内容脚本的模拟字幕。' }] }),
    }));
    const video = await context.newPage();
    await video.goto('https://www.bilibili.com/video/BV1234567890');
    await page.waitForFunction(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      try { return (await chrome.tabs.sendMessage(tab.id, { type: 'PING' })).ok; } catch (_) { return false; }
    });
    const extracted = await page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/core.js', 'content.js'] });
      return chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT', opts: { withTs: false } });
    });
    assert.equal(extracted.ok, true);
    assert.equal(extracted.data.ok, true);
    assert.match(extracted.data.text, /真实内容脚本/);
    assert.equal(extracted.data.title, '模拟站点视频');
    assert.deepEqual(errors, []);
    console.log('Real extension checks passed: manifest/service worker, options, session result, fetch validation and actual content script extraction/reinjection with mocked site data.');
  } finally { await context.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });

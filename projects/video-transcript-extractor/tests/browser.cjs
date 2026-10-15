/** Browser smoke checks with deterministic Chrome API and network fixtures.
 * Run with Playwright on NODE_PATH and optionally BROWSER_EXECUTABLE.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../extension');
const artifacts = path.resolve(process.env.TEST_ARTIFACTS || path.join(__dirname, '../.test-artifacts/browser'));
fs.mkdirSync(artifacts, { recursive: true });
const data = {
  ok: true, title: '从字幕到笔记：一份完整的视频文稿', platform: 'bilibili', uploader: '示例频道',
  durationText: '12:30', partGot: 2, partTotal: 3, chars: 268, isAi: true, withTs: true,
  markdown: '# 视频标题\n\n> P3 无字幕\n---\n旧文稿',
  parts: [
    { page: 1, title: '理解问题', items: [{ from: 10, to: 18, content: '嗯，大家好。就是说，重要的事情需要重复。重要的事情需要重复。这个方案是不是可行？不是。' }, { from: 18, to: 25, content: 'Hello' }, { from: 25, to: 30, content: 'world，这是一次字幕提取测试。<img src=x onerror=alert(1)>' }] },
    { page: 2, title: '实践方法', items: [{ from: 0, to: 15, content: '第二部分从零秒开始，时间戳应该与第一部分分别计算。' }] },
  ], missing: [{ page: 3, reason: '无字幕轨道' }],
};
const initial = {
  settings: { withTimestamp: true, transcriptMode: 'sub', transcriptDir: '../字幕/../../2026', aiMode: 'sub', termFixes: '',
    ai: { baseUrl: 'https://api.test/v1', apiKey: 'test-key', model: 'fixture' } },
  lastResult: { ...data, title: '错误的上次结果' },
};
const snapshots = {
  'result:first': { data, opts: { withTs: false }, mode: 'transcript', createdAt: 1 },
  'result:second': { data: { ...data, title: '第二个视频' }, opts: { withTs: true }, mode: 'transcript', createdAt: 2 },
  'result:auto': { data, opts: { withTs: true }, mode: 'aisum', createdAt: 3 },
  'result:noise': { data: { ...data, title: '闲聊', parts: [], items: [{ content: '嗯。呃。大家好。大家听明白了吗？' }] }, opts: {}, mode: 'transcript', createdAt: 4 },
};
const server = http.createServer((req, res) => {
  const relative = new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'result.html';
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : 'image/png';
  res.writeHead(200, { 'Content-Type': type + ';charset=utf-8' });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    let aiCalls = 0;
    let aiPayload;
    await context.addInitScript(({ initial, snapshots }) => {
      if (!localStorage.getItem('mockLocal')) localStorage.setItem('mockLocal', JSON.stringify(initial));
      if (!localStorage.getItem('mockSession')) localStorage.setItem('mockSession', JSON.stringify(snapshots));
      function storage(name) {
        return {
          async get(keys) {
            const all = JSON.parse(localStorage.getItem(name) || '{}');
            if (keys == null) return all;
            const list = typeof keys === 'string' ? [keys] : keys;
            return Object.fromEntries(list.filter((k) => k in all).map((k) => [k, all[k]]));
          },
          async set(patch) {
            const all = JSON.parse(localStorage.getItem(name) || '{}');
            localStorage.setItem(name, JSON.stringify({ ...all, ...patch }));
          },
          async remove(keys) {
            const all = JSON.parse(localStorage.getItem(name) || '{}');
            for (const key of keys) delete all[key];
            localStorage.setItem(name, JSON.stringify(all));
          },
        };
      }
      globalThis.chrome = {
        storage: { local: storage('mockLocal'), session: storage('mockSession') },
        runtime: { getURL: (p) => location.origin + '/' + p, openOptionsPage: async () => {} },
        downloads: { download: async (args) => { globalThis.__download = args; return 1; } },
        permissions: { contains: async () => true, request: async () => true },
        scripting: { executeScript: async () => {} },
        tabs: {
          query: async () => [{ id: 1, url: globalThis.__activeUrl || 'https://www.youtube.com/watch?v=fixture', title: '测试视频' }],
          sendMessage: async (_, msg) => msg.type === 'PING' ? { ok: true, title: '测试视频' } : { ok: true, data: snapshots['result:first'].data },
          create: async (args) => { globalThis.__created = args; },
        },
      };
    }, { initial, snapshots });
    await context.route('https://api.test/**', async (route) => {
      aiCalls++;
      aiPayload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        'data: {"choices":[{"delta":{"content":"## 关键观点\\n\\n这是一份完整的总结。"}}]}\n\ndata: [DONE]\n\n' });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/result.html?id=first');
    await page.locator('#docC h1').waitFor();
    assert.equal(await page.locator('#ttl').textContent(), data.title);
    assert.equal(await page.locator('[data-tab="clean"]').evaluate((el) => el.classList.contains('active')), true);
    assert.equal((await page.locator('#docC').textContent()).match(/重要的事情需要重复/g).length, 1);
    assert.equal((await page.locator('#docT').textContent()).match(/重要的事情需要重复/g).length, 2);
    assert(!(await page.locator('#docC').textContent()).includes('大家好'));
    assert((await page.locator('#docC').textContent()).includes('是不是可行？不是。'));
    assert.match(await page.locator('#cleanStats').textContent(), /合并 1 处重复/);
    assert.equal(await page.locator('#docT .ts').count(), 0);
    assert.equal(await page.locator('#docT h3').count(), 2);
    assert.equal(await page.locator('#docT img').count(), 0);
    assert.match(await page.locator('#warnings').textContent(), /P3/);
    await page.screenshot({ path: path.join(artifacts, 'result-desktop.png'), fullPage: true });
    await page.locator('[data-tab="aisum"]').click();
    assert(await page.locator('#btnSave').isDisabled());
    await page.locator('#btnDoAi').click();
    await page.locator('#docA h2').waitFor();
    assert(!(await page.locator('#btnSave').isDisabled()));
    assert.equal(aiCalls, 1);
    assert(!aiPayload.messages.at(-1).content.includes('大家好'));
    assert.equal(aiPayload.messages.at(-1).content.match(/重要的事情需要重复/g).length, 1);
    await page.reload();
    await page.locator('#docA h2').waitFor({ state: 'attached' });
    assert.equal(aiCalls, 1, 'Refreshing a completed result must not call AI again');

    await page.goto(base + '/result.html?id=second');
    await page.locator('#docC .ts').first().waitFor();
    assert.equal(await page.locator('#ttl').textContent(), '第二个视频');
    assert.equal(await page.locator('#docT .ts').nth(1).textContent(), '00:00');
    await page.locator('[data-tab="transcript"]').click();
    assert.equal(await page.locator('#docT').isVisible(), true);
    await page.locator('[data-tab="clean"]').click();
    await page.locator('#btnSave').click();
    await page.waitForFunction(() => !!globalThis.__download);
    assert.equal(await page.evaluate(() => __download.filename.startsWith('字幕/2026/')), true);
    assert.equal(await page.evaluate(() => __download.filename.endsWith('_精简文稿.md')), true);
    await page.locator('#btnAs').click();
    await page.waitForFunction(() => globalThis.__download.saveAs === true);
    assert.equal(await page.evaluate(() => __download.filename.includes('/')), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'result-mobile.png'), fullPage: true });

    await page.goto(base + '/result.html?id=missing');
    await page.waitForFunction(() => document.querySelector('#ttl').textContent.includes('过期'));
    assert(await page.locator('#btnAs').isDisabled());
    await page.goto(base + '/result.html?id=auto');
    await page.locator('#docA h2').waitFor();
    const autoCalls = aiCalls;
    await page.reload();
    await page.locator('#docA h2').waitFor();
    assert.equal(aiCalls, autoCalls);
    await page.goto(base + '/result.html?id=noise');
    await page.waitForFunction(() => document.querySelector('#docC').textContent.includes('没有可保留'));
    assert(await page.locator('#btnSave').isDisabled());
    await page.locator('[data-tab="transcript"]').click();
    assert(!(await page.locator('#btnSave').isDisabled()));
    await page.locator('[data-tab="aisum"]').click();
    assert(await page.locator('#btnDoAi').isDisabled());

    await page.goto(base + '/options.html');
    await page.locator('#aiKey').waitFor();
    await page.waitForFunction(() => document.querySelector('#aiKey').value === 'test-key');
    assert.equal(await page.locator('#aiKey').getAttribute('type'), 'password');
    await page.locator('#termFixes').fill('错词=正确词');
    await page.locator('#termFixes').blur();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mockLocal')).settings.termFixes === '错词=正确词');
    await page.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, transcriptDir: '另一个页面的新路径' } });
    });
    await page.locator('#withTimestamp').uncheck();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mockLocal')).settings.withTimestamp === false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mockLocal')).settings.transcriptDir), '另一个页面的新路径');
    await page.screenshot({ path: path.join(artifacts, 'options-mobile.png'), fullPage: true });

    await page.goto(base + '/popup.html');
    await page.waitForFunction(() => !document.querySelector('#runTranscript').disabled);
    assert.equal(await page.locator('#allP').isVisible(), false);
    assert.equal(await page.locator('#translateCn').isVisible(), true);
    await page.screenshot({ path: path.join(artifacts, 'popup.png'), fullPage: true });
    await page.locator('#runTranscript').click();
    await page.waitForFunction(() => !!globalThis.__created);
    assert.match(await page.evaluate(() => __created.url), /result\.html\?id=/);
    assert.deepEqual(errors, [], 'No browser page errors');
    console.log('Browser checks passed: default clean view, raw comparison, cleaned AI input, all-noise state, separate saving, result isolation, timestamps, escaping, cache, narrow layout, settings and popup snapshot.');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => server.close());

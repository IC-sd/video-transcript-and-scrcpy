const { test } = require('node:test');
const assert = require('node:assert/strict');
const { context, load, contentContext, json } = require('./helpers.cjs');
test('URL matching rejects lookalike hosts and non-video paths', () => {
  const core = load(context(), 'lib/core.js').BiliCore;
  assert.equal(core.platform('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(core.platform('https://m.youtube.com/shorts/abc'), 'youtube');
  for (const url of ['https://evil.test/youtube.com/watch?v=abc', 'https://www.youtube.com.evil.test/watch?v=abc', 'https://www.youtube.com/watchlater', 'http://www.youtube.com/watch?v=abc']) {
    assert.equal(core.platform(url), '');
  }
  assert.equal(core.subtitleUrl('https://i0.hdslb.com/subtitle/a.json'), true);
  for (const url of ['https://hdslb.com.evil.test/a', 'file:///secret', 'https://user:password@www.youtube.com/a']) assert.equal(core.subtitleUrl(url), false);
});
test('download filenames remove traversal, control chars and Windows devices', () => {
  const core = load(context(), 'lib/core.js').BiliCore;
  assert.equal(core.cleanDir('../字幕/../../2026'), '字幕/2026');
  assert.equal(core.safeName('CON'), '_CON');
  assert.equal(core.safeName('abc... '), 'abc');
  assert(!core.safeName('a\u0001/b').includes('\u0001'));
});
test('request timeout covers a stalled response body', async () => {
  const c = context({ fetch: async (_, { signal }) => ({ ok: true, text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))) }) });
  const core = load(c, 'lib/core.js').BiliCore;
  await assert.rejects(core.request('https://example.test', {}, 'text', 10), /超时/);
});
test('faithful transcript keeps short sentences, repetitions and English word boundaries', () => {
  const polish = load(context(), 'lib/polish.js').BiliPolish;
  const items = [
    { from: 0, to: 1, content: '是。' },
    { from: 2, to: 3, content: '重要的事情需要重复。' },
    { from: 4, to: 5, content: '重要的事情需要重复。' },
    { from: 6, to: 7, content: 'Hello' }, { from: 7, to: 8, content: 'world' },
  ];
  const text = polish.polish(items, { keepFillers: true }).paragraphs.join('\n');
  assert(text.includes('是。'));
  assert.equal(text.match(/重要的事情需要重复/g).length, 2);
  assert(text.includes('Hello world'));
  assert.equal(polish.polish([{ from: 0, to: 1, content: 'Hello world.' }], { keepFillers: true }).paragraphs[0], 'Hello world.');
});
test('part headings and each part timestamp survive formatting; timestamp option wins', () => {
  const c = context(); load(c, 'lib/polish.js'); load(c, 'lib/transcript.js');
  const data = { title: '合集', markdown: '# 合集\n\n> P3 失败\n---\nold', parts: [
    { page: 1, title: '开场', items: [{ from: 10, to: 11, content: '第一部分的内容。' }] },
    { page: 2, title: '细节', items: [{ from: 0, to: 1, content: '第二部分的内容。' }] },
  ] };
  const withTime = c.BiliTranscript.format(data, { withTs: true });
  assert(withTime.text.includes('## P1 开场\n\n[00:10]'));
  assert(withTime.text.includes('## P2 细节\n\n[00:00]'));
  assert(withTime.markdown.includes('P3 失败'));
  assert(!c.BiliTranscript.format(data, { withTs: false }).text.includes('[00:'));
});
test('reinjecting a content script is safe and registers one message listener', async () => {
  const { c, listeners, send } = contentContext(async () => json({}));
  load(c, 'content.js');
  assert.equal(listeners.length, 1);
  assert.equal((await send({ type: 'PING' })).ok, true);
});
test('Bilibili partial extraction keeps successful parts and explains missing ones', async () => {
  const { send } = contentContext(async (url) => {
    if (url.includes('/view?')) return json({ code: 0, data: { title: '合集', owner: { name: '测试' }, duration: 30,
      pages: [{ cid: 1, page: 1, part: '上' }, { cid: 2, page: 2, part: '下' }] } });
    if (url.includes('cid=1')) return json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://i0.hdslb.com/a.json' }] } } });
    if (url.includes('cid=2')) return json({ code: 0, data: {} });
    return json({ body: [{ from: 0, to: 1, content: '测试字幕' }] });
  });
  const result = await send({ type: 'EXTRACT', opts: { allP: true, withTs: false } });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.parts.length, 1);
  assert.equal(result.data.missing[0].page, 2);
  assert.equal(result.data.withTs, false);
});
test('YouTube SPA fallback rejects a player response from a previous video', async () => {
  const { c, send } = contentContext(async () => { throw new Error('offline'); }, 'https://www.youtube.com/watch?v=newVideo');
  c.ytInitialPlayerResponse = { videoDetails: { videoId: 'oldVideo' } };
  const result = await send({ type: 'EXTRACT', opts: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /页面数据也没取到/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { context, load, json } = require('./helpers.cjs');
const cfg = { baseUrl: 'https://api.test/v1', apiKey: 'fake-key', model: 'test' };
const video = { title: '测试', text: '完整字幕' };
function api(fetch) { return load(context({ fetch }), 'lib/aisum.js').BiliAiSum; }
function stream(parts) {
  const encoded = parts.map((s) => new TextEncoder().encode(s));
  return new Response(new ReadableStream({ start(c) { for (const bytes of encoded) c.enqueue(bytes); c.close(); } }),
    { headers: { 'content-type': 'text/event-stream' } });
}
test('chunking bounds a giant paragraph, keeps all text and preserves surrogate pairs', () => {
  const a = api();
  for (const text of ['a'.repeat(30000), ('正文😀\n\n更多内容').repeat(3000)]) {
    const chunks = a.splitChunks(text, 101);
    assert.equal(chunks.join(''), text);
    assert(chunks.every((c) => c.length <= 101 && !/[\uD800-\uDBFF]$/.test(c)));
  }
});
test('endpoint validates HTTPS and does not append the endpoint twice', () => {
  const a = api();
  assert.equal(a.endpoint('https://api.test/v1/'), 'https://api.test/v1/chat/completions');
  assert.equal(a.endpoint('https://api.test/v1/chat/completions'), 'https://api.test/v1/chat/completions');
  for (const raw of ['http://api.test', 'https://secret@api.test', 'https://api.test?key=secret']) assert.throws(() => a.endpoint(raw));
});
test('SSE handles split JSON chunks, CRLF and final event without newline', async () => {
  const a = api(async () => stream([': heartbeat\r\ndata: {"cho', 'ices":[{"delta":{"content":"你好"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"世界"}}]}\n', 'data: [DONE]']));
  let output;
  assert.equal(await a.summarize(cfg, video, (_, all) => { output = all; }), '你好世界');
  assert.equal(output, '你好世界');
});
test('truncated SSE and provider errors fail instead of accepting incomplete summaries', async () => {
  for (const payload of [
    'data: {"choices":[{"delta":{"content":"半截"}}]}\n',
    'data: {"error":{"message":"provider failed"}}\n',
    'data: {"choices":[{"delta":{"content":"半截"},"finish_reason":"length"}]}\n',
    'data: {bad json}\n',
  ]) await assert.rejects(api(async () => stream([payload])).summarize(cfg, video, () => {}));
});
test('an API that ignores streaming and returns JSON remains supported', async () => {
  let shown;
  const a = api(async () => json({ choices: [{ message: { content: '完整总结' } }] }));
  assert.equal(await a.summarize(cfg, video, (_, all) => { shown = all; }), '完整总结');
  assert.equal(shown, '完整总结');
});
test('HTTP errors explain status without exposing provider response secrets', async () => {
  const a = api(async () => new Response('fake-key private-response', { status: 401 }));
  await assert.rejects(a.summarize(cfg, video), (e) => /401/.test(e.message) && !e.message.includes('fake-key'));
});
test('AI requests can be cancelled and time out', async () => {
  const a = api(async (_, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    else signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await assert.rejects(a.summarize({ ...cfg, timeoutMs: 10 }, video), /超时/);
  const ctrl = new AbortController();
  const pending = a.summarize({ ...cfg, signal: ctrl.signal }, video);
  ctrl.abort();
  await assert.rejects(pending, /已停止/);
});
test('long transcripts are chunked before a final summary, without retry loops', async () => {
  const requests = [];
  const a = api(async (_, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    return json({ choices: [{ message: { content: requests.length <= 3 ? '要点' : '最终总结' } }] });
  });
  const result = await a.summarize(cfg, { ...video, text: '文'.repeat(2500) }, null, 1000);
  assert.equal(requests.length, 4);
  assert.equal(result, '最终总结');
  assert(requests.slice(0, 3).every((r) => r.messages[1].content.length < 1500));
});

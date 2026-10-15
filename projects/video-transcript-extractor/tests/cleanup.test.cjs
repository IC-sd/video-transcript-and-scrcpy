const { test } = require('node:test');
const assert = require('node:assert/strict');
const { context, load } = require('./helpers.cjs');
function cleaner() { return load(context(), 'lib/polish.js').BiliPolish; }
function run(text, options = {}) {
  return cleaner().clean([{ from: 0, to: 20, content: text }], options);
}
test('removes fillers, greetings, repeated statements and interaction questions', () => {
  const result = run('嗯，大家好。就是说，我们先确定范围。我们先确定范围。大家听明白了吗？这个方案是不是可行？不是。不行。如果预算不足的话，就不采购。');
  const body = result.paragraphs.join('\n');
  assert.equal(result.stats.repeatCount, 1);
  assert.equal(result.stats.discardedCount, 2);
  assert(!/大家好|就是说|听明白|嗯/.test(body));
  assert.equal(body.match(/我们先确定范围/g).length, 1);
  assert(body.includes('这个方案是不是可行？'));
  assert(body.includes('不是。不行。'));
  assert(body.includes('如果预算不足的话，就不采购。'));
  assert(result.stats.removedChars > 10);
});
test('merges repeated substantive questions while retaining their answers', () => {
  const body = run('这个问题应该怎么解决？这个问题应该怎么解决？先检查网络，再检查权限。').paragraphs.join('');
  assert.equal(body.match(/这个问题应该怎么解决/g).length, 1);
  assert(body.includes('先检查网络'));
  assert(body.includes('再检查权限'));
});
test('does not merge different numbers, units, polarity or conditions', () => {
  const body = run('收入是10%。收入是10。预算为100万元。预算为200万元。这个方案可行。这个方案不可行。如果批准才执行。没有批准不执行。').paragraphs.join('');
  for (const part of ['10%', '10。', '100万元', '200万元', '方案可行', '方案不可行', '如果批准才执行', '没有批准不执行']) assert(body.includes(part), part);
});
test('cross-entry stutters and filler words leave clean punctuation', () => {
  const result = cleaner().clean([
    { from: 0, to: 1, content: '嗯嗯我们先确定' },
    { from: 1, to: 3, content: '范围我们先确定范围，呃，这一步很关键，对吧。' },
  ]);
  const body = result.paragraphs.join('');
  assert.equal(body.match(/我们先确定范围/g).length, 1);
  assert(!body.includes('对'));
  assert(!/[，,]{2,}|[，,]。/.test(body));
});
test('does not delete pieces of words that resemble filler phrases', () => {
  const body = run('这个方案需要审核。那个设备是新的。就是说服客户这一步最难。哈密瓜已经成熟。').paragraphs.join('');
  assert(body.includes('这个方案'));
  assert(body.includes('那个设备'));
  assert(body.includes('说服客户'));
  assert(body.includes('哈密瓜'));
});
test('English fillers and repeated dialogue are cleaned without erasing factual differences', () => {
  const body = run('Um, we need a plan. We need a plan. The rate is 10%. The rate is 10. We cannot proceed. We can proceed.').paragraphs.join('');
  assert(!/\bum\b/i.test(body));
  assert.equal((body.match(/we need a plan/gi) || []).length, 1);
  assert(body.includes('10%'));
  assert(body.includes('10.'));
  assert(body.includes('cannot proceed'));
  assert(body.includes('can proceed'));
});
test('part-local cleanup retains each part heading and starts its own timestamp', () => {
  const c = context(); load(c, 'lib/polish.js'); load(c, 'lib/transcript.js');
  const repeated = '核心结论需要检查。核心结论需要检查。';
  const result = c.BiliTranscript.format({ title: '合集', partTotal: 2, parts: [
    { page: 1, title: '一', items: [{ from: 10, to: 11, content: repeated }] },
    { page: 2, title: '二', items: [{ from: 0, to: 1, content: repeated }] },
  ] }, { clean: true, withTs: true });
  assert.equal(result.stats.repeatCount, 2);
  assert.equal(result.text.match(/核心结论需要检查/g).length, 2);
  assert(result.text.includes('## P1 一\n\n[00:10]'));
  assert(result.text.includes('## P2 二\n\n[00:00]'));
  assert(result.markdown.includes('—— 精简文稿'));
});
test('all-noise input produces an empty clean result without falling back to the original', () => {
  const c = context(); load(c, 'lib/polish.js'); load(c, 'lib/transcript.js');
  const result = c.BiliTranscript.format({ title: '闲聊', items: [{ content: '嗯。呃。大家好。大家听明白了吗？' }] }, { clean: true });
  assert.equal(result.text, '');
  assert.equal(result.stats.outChars, 0);
});
test('cleanup keeps timing after removing a leading filler-only subtitle entry', () => {
  const result = cleaner().clean([{ from: 0, to: 1, content: '嗯，' }, { from: 5, to: 10, content: '这是正文中的核心结论。' }], { withTime: true });
  assert(result.paragraphs[0].startsWith('[00:05]'));
});
test('short-word stutters collapse while meaningful connective words remain', () => {
  const body = run('我我觉得，我们我们需要先确认范围，然后然后再制定计划。').paragraphs.join('');
  assert(!body.includes('我我'));
  assert(!body.includes('我们我们'));
  assert(!body.includes('然后然后'));
  assert(body.includes('然后再制定计划'));
});
test('identical comma-separated clauses collapse once without merging different facts', () => {
  const body = run('我们的目标是提高效率，我们的目标是提高效率。预算是100万元，预算是200万元。').paragraphs.join('');
  assert.equal(body.match(/我们的目标是提高效率/g).length, 1);
  assert(body.includes('100万元'));
  assert(body.includes('200万元'));
});
test('opening greetings can be removed from a longer sentence without damaging words', () => {
  const body = run('大家好，欢迎来到我的频道，今天介绍三种方法。大家好奇这个工具为什么有效。').paragraphs.join('');
  assert(!body.includes('欢迎来到我的频道'));
  assert(body.includes('今天介绍三种方法'));
  assert(body.includes('大家好奇这个工具为什么有效'));
});

/** Identify the active video and persist an independent snapshot for its result tab. */
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const buttons = [$('runTranscript'), $('runAi')];
function setStatus(text, cls = '') {
  statusEl.textContent = text || '';
  statusEl.className = 'status ' + cls;
}
async function ensureInjected(tab) {
  if (BiliCore.platform(tab.url) === 'youtube') {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['inject_hook.js'] });
  }
  try {
    const ping = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (ping && ping.ok) return ping;
  } catch (_) { /* Install fallback below. */ }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/core.js', 'content.js'] });
  return chrome.tabs.sendMessage(tab.id, { type: 'PING' });
}
$('openOpts').addEventListener('click', () => chrome.runtime.openOptionsPage());

(async function init() {
  const stored = await chrome.storage.local.get(['settings', 'lastOpts']);
  const s = stored.settings || {};
  $('allP').checked = !!s.allParts;
  $('withTs').checked = s.withTimestamp !== false;
  $('translateCn').checked = !!(stored.lastOpts || {}).translateCn;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = tab && BiliCore.platform(tab.url);
  if (!platform) {
    $('vtitle').textContent = '请打开 B站或 YouTube 视频';
    $('vmeta').textContent = '支持视频页和 YouTube Shorts';
    return;
  }
  $('allP').closest('label').hidden = platform !== 'bilibili';
  $('translateCn').closest('label').hidden = platform !== 'youtube';
  let ping;
  try { ping = await ensureInjected(tab); } catch (_) { /* Show connection error. */ }
  if (!ping || !ping.ok) {
    $('vtitle').textContent = '无法连接页面';
    setStatus('请刷新视频页面后再试。', 'err');
    return;
  }
  $('vtitle').textContent = (ping.title || tab.title || '已识别视频')
    .replace(/[_\-|]\s*哔哩哔哩.*$/, '').replace(/ - YouTube$/, '').trim();
  $('vmeta').textContent = (platform === 'youtube' ? 'YouTube' : 'B站') + ' · 已就绪';
  buttons.forEach((b) => { b.disabled = false; });
  let busy = false;
  async function run(mode) {
    if (busy) return;
    busy = true;
    const opts = {
      allP: platform === 'bilibili' && $('allP').checked,
      withTs: $('withTs').checked,
      translateCn: platform === 'youtube' && $('translateCn').checked,
    };
    const button = mode === 'aisum' ? $('runAi') : $('runTranscript');
    const label = button.textContent;
    buttons.forEach((b) => { b.disabled = true; });
    button.textContent = '正在提取…';
    setStatus('正在读取字幕，请保持此面板打开…');
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT', opts });
      if (!resp || !resp.ok || !resp.data || !resp.data.ok) {
        throw new Error((resp && (resp.error || (resp.data && resp.data.error))) || '没有取到字幕');
      }
      const id = crypto.randomUUID();
      const key = 'result:' + id;
      const record = { data: resp.data, opts, mode, createdAt: Date.now() };
      await chrome.storage.session.set({ [key]: record });
      await chrome.storage.local.set({ lastOpts: opts });
      await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') + '?id=' + encodeURIComponent(id) });
      const all = await chrome.storage.session.get(null);
      const expired = Object.keys(all).filter((k) => k.startsWith('result:'))
        .sort((a, b) => all[b].createdAt - all[a].createdAt).slice(10);
      if (expired.length) await chrome.storage.session.remove(expired);
      window.close();
    } catch (e) {
      setStatus('提取失败：' + (e.message || e) + '。可刷新视频页面后重试。', 'err');
    } finally {
      busy = false;
      buttons.forEach((b) => { b.disabled = false; });
      button.textContent = label;
    }
  }
  $('runTranscript').addEventListener('click', () => run('transcript'));
  $('runAi').addEventListener('click', () => run('aisum'));
})().catch((e) => setStatus('初始化失败：' + (e.message || e), 'err'));

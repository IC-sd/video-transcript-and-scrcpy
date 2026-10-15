(function () {
'use strict';
if (window.__biliTxInjected) return;
/**
 * content.js —— 在 B站页面里跑，用页面自身的登录态调官方接口取字幕。
 *
 * 为什么放在 content script 而不是 background：
 * 这里天然带着页面的 Cookie 与同站 Origin，不需要额外处理凭证，
 * 也不会撞上扩展后台请求不带 Cookie 的问题。
 */

const API = 'https://api.bilibili.com';

function getBvid() {
  const m = location.href.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

function currentPage() {
  const p = new URLSearchParams(location.search).get('p');
  return p ? parseInt(p, 10) : 1;
}

async function jsonGet(url) {
  return BiliCore.request(url, { credentials: 'include' }, 'json');
}

/**
 * 取跨域文本资源（字幕 JSON 挂在 hdslb.com 这类 CDN 上）。
 * 页面里直接 fetch 会被 CORS 拦掉，所以优先试一次、失败就交给后台脚本代取
 * —— 后台有 host_permissions，不受 CORS 限制。
 */
async function textGet(url) {
  try {
    if (!BiliCore.subtitleUrl(url)) throw new Error('字幕地址不受支持');
    return await BiliCore.request(url, { credentials: 'include' });
  } catch (e) { /* 落到后台代取 */ }
  if (!BiliCore.subtitleUrl(url)) throw new Error('字幕地址不受支持');
  const resp = await chrome.runtime.sendMessage({ type: 'FETCH_TEXT', url });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || '字幕资源下载失败');
  return resp.text;
}

function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/**
 * 中文之间不该有空格。
 * YouTube 的自动翻译字幕是按源语言断句再逐段翻译的，会在中文词中间留下空格
 * （"你懂规则，我也 懂"），英文则必须保留空格，所以只清理中日韩文字之间的空白。
 */
function tidyCjk(s) {
  let prev;
  let out = String(s);
  do {
    prev = out;
    out = out.replace(/([\u4e00-\u9fa5\u3040-\u30ff\uff00-\uffef])\s+([\u4e00-\u9fa5\u3040-\u30ff\uff00-\uffef])/g, '$1$2');
  } while (out !== prev);
  return out;
}

/** 把字幕条目按时间间隔合并成自然段落 */
function bodyToText(body, withTs, mergeGap = 2.0) {
  const blocks = [];
  let buf = [];
  let start = null;
  let lastEnd = null;
  for (const it of body) {
    const content = (it.content || '').trim();
    if (!content) continue;
    const from = parseFloat(it.from || 0);
    const to = parseFloat(it.to != null ? it.to : from);
    if (lastEnd !== null && from - lastEnd > mergeGap && buf.length) {
      blocks.push({ start, text: buf.reduce((a, b) => smartJoin(a, b), '') });
      buf = [];
      start = null;
    }
    if (start === null) start = from;
    buf.push(content);
    lastEnd = to;
  }
  if (buf.length) blocks.push({ start, text: buf.reduce((a, b) => smartJoin(a, b), '') });

  const cleaned = blocks
    .map((b) => ({ start: b.start, text: tidyCjk(b.text.replace(/\s+/g, ' ')).trim() }))
    .filter((b) => b.text);
  if (!withTs) return { text: cleaned.map((b) => b.text).join('\n'), blocks: cleaned };
  return {
    text: cleaned.map((b) => `[${fmtTime(b.start)}] ${b.text}`).join('\n\n'),
    blocks: cleaned,
  };
}

/** 优先人工 CC 中文字幕，其次 B站 AI 中文字幕 */
function pickTrack(tracks, prefer) {
  if (!tracks || !tracks.length) return null;
  if (prefer) {
    const hit = tracks.find((t) => t.lan === prefer);
    if (hit) return hit;
  }
  const manual = tracks.filter((t) => !(t.lan || '').startsWith('ai-'));
  const zhManual = manual.filter((t) => (t.lan || '').includes('zh'));
  if (zhManual.length) return zhManual[0];
  if (manual.length) return manual[0];
  const aiZh = tracks.find((t) => t.lan === 'ai-zh');
  if (aiZh) return aiZh;
  return tracks[0];
}

async function extractPart(bvid, part, withTs, prefer) {
  const url = `${API}/x/player/wbi/v2?bvid=${bvid}&cid=${part.cid}`;
  const d = await jsonGet(url);
  if (d.code !== 0) {
    return { ...part, ok: false, reason: `接口返回 ${d.code}：${d.message || ''}` };
  }
  const tracks = (d.data && d.data.subtitle && d.data.subtitle.subtitles) || [];
  if (!tracks.length) {
    return { ...part, ok: false, reason: '无字幕轨道' };
  }
  const track = pickTrack(tracks, prefer);
  if (!track || !track.subtitle_url) {
    return { ...part, ok: false, reason: '字幕地址缺失' };
  }
  const subUrl = track.subtitle_url.startsWith('//') ? 'https:' + track.subtitle_url : track.subtitle_url;
  const raw = JSON.parse(await textGet(subUrl));
  const body = raw.body || [];
  const { text, blocks } = bodyToText(body, withTs);
  if (!text) return { ...part, ok: false, reason: '字幕内容为空' };

  return {
    ...part,
    ok: true,
    reason: '',
    text,
    blocks,
    items: body.map((it) => ({
      from: parseFloat(it.from || 0),
      to: parseFloat(it.to || 0),
      content: (it.content || '').trim(),
    })),
    lan: track.lan,
    lan_doc: track.lan_doc,
    is_ai: (track.lan || '').startsWith('ai-'),
    chars: text.replace(/\s/g, '').length,
    tracks: tracks.map((t) => ({ lan: t.lan, doc: t.lan_doc, ai: (t.lan || '').startsWith('ai-') })),
  };
}

async function extractBilibili(opts) {
  const { allP = false, withTs = true, prefer = '' } = opts || {};
  const bvid = getBvid();
  if (!bvid) {
    throw new Error('当前页面不是 B站视频页（地址栏里需要有 BV 开头的编号）');
  }

  const viewResp = await jsonGet(`${API}/x/web-interface/view?bvid=${bvid}`);
  if (viewResp.code !== 0) {
    throw new Error(`取视频信息失败：${viewResp.message || viewResp.code}`);
  }
  const info = viewResp.data;
  const pages = info.pages && info.pages.length
    ? info.pages
    : [{ cid: info.cid, page: 1, part: info.title }];

  let parts = pages.map((p) => ({
    cid: p.cid,
    page: p.page || 1,
    title: p.part || p.title || info.title,
  }));

  let truncated = false;
  if (!allP) {
    const want = currentPage();
    const picked = parts.filter((p) => p.page === want);
    parts = picked.length ? picked : parts.slice(0, 1);
  } else if (parts.length > 30) {
    parts = parts.slice(0, 30);
    truncated = true;
  }

  const results = [];
  for (const p of parts) {
    try {
      results.push(await extractPart(bvid, p, withTs, prefer));
    } catch (e) {
      results.push({ ...p, ok: false, reason: String(e.message || e) });
    }
  }

  const got = results.filter((r) => r.ok);
  const miss = results.filter((r) => !r.ok);

  const blocks = [];
  for (const r of got) {
    blocks.push(results.length > 1 ? `## P${r.page} ${r.title}\n\n${r.text}` : r.text);
  }
  const allItems = [];
  for (const r of got) allItems.push(...(r.items || []));

  const meta = [
    `# ${info.title}`,
    '',
    `- BV号: ${bvid}`,
    `- UP主: ${info.owner.name}`,
    `- 时长: ${fmtTime(info.duration)}`,
    `- 链接: https://www.bilibili.com/video/${bvid}${!allP ? '?p=' + parts[0].page : ''}`,
  ];
  if (got.length) meta.push(`- 字幕来源: ${got[0].lan_doc} (${got[0].lan})`);
  meta.push(`- 抓取时间: ${new Date().toLocaleString('zh-CN')}`);
  if (info.desc && info.desc.trim()) meta.push('', '## 视频简介', '', info.desc.trim());
  for (const m of miss) meta.push('', `> 注意：P${m.page} ${m.title} 未取到字幕 —— ${m.reason}`);
  if (truncated) meta.push('', '> 分P较多，本次只处理了前 30 个。');

  return {
    ok: got.length > 0,
    platform: 'bilibili',
    bvid,
    title: info.title,
    uploader: info.owner.name,
    duration: info.duration,
    durationText: fmtTime(info.duration),
    partTotal: pages.length,
    partGot: got.length,
    chars: got.reduce((s, r) => s + (r.chars || 0), 0),
    lan: got.length ? got[0].lan_doc : '',
    isAi: got.length ? got[0].is_ai : false,
    tracks: got.length ? got[0].tracks : [],
    text: blocks.join('\n\n'),
    items: allItems,
    parts: got.map((r) => ({ page: r.page, title: r.title, text: r.text, items: r.items })),
    truncated,
    withTs,
    markdown: meta.join('\n') + '\n\n---\n\n' + blocks.join('\n\n'),
    missing: miss.map((m) => ({ page: m.page, title: m.title, reason: m.reason })),
    error: got.length ? '' : (miss[0] ? miss[0].reason : '未知原因'),
    fetchedAt: Date.now(),
  };
}

// ==================================================== YouTube 适配器

function ytVideoId() {
  try {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v') || '';
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || '';
  } catch (e) { /* ignore */ }
  return '';
}

/**
 * 条目拼接：两边都是中日韩文字就直接连（中文不用空格分词），
 * 否则补一个空格 —— 否则英文跨条目会拼成 "tolove" / "doI"。
 */
function smartJoin(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const cjkEnd = /[\u4e00-\u9fa5\u3040-\u30ff\uff01-\uff5e。，！？；：、]$/.test(a);
  const cjkStart = /^[\u4e00-\u9fa5\u3040-\u30ff\uff01-\uff5e。，！？；：、]/.test(b);
  if (cjkEnd && cjkStart) return a + b;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  if (/[，。！？；：、]$/.test(a) || /^[，。！？；：、]/.test(b)) return a + b;
  return a + ' ' + b;
}

/**
 * 从页面 script 标签里挖 ytInitialPlayerResponse。
 * 这条路不依赖播放器是否初始化 —— YouTube 懒加载播放器，页面滚到评论区时
 * #movie_player 上可能根本没有 getPlayerResponse() 方法。
 */
function ytExtractJsonAt(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

function ytScanScripts() {
  const KEY = 'ytInitialPlayerResponse';
  for (const s of document.querySelectorAll('script')) {
    const t = s.textContent;
    if (!t || t.indexOf(KEY) < 0) continue;
    const eq = t.indexOf('=', t.indexOf(KEY));
    if (eq < 0) continue;
    const start = t.indexOf('{', eq);
    if (start < 0) continue;
    const json = ytExtractJsonAt(t, start);
    if (!json) continue;
    try {
      const obj = JSON.parse(json);
      if (obj && obj.videoDetails) return obj;
    } catch (e) { /* 换下一个 script */ }
  }
  return null;
}

/**
 * 通过 innertube 的 VISIONOS client 拿播放器数据。
 * 页面 WEB client 给出的字幕地址直接请求会返回 200 + 空体（YouTube 的 POT 防绕过），
 * VISIONOS client 给出的地址裸请求就有数据 —— 已实测两种 User-Agent 均可。
 */
async function ytInnertubePlayer(videoId) {
  const j = await BiliCore.request('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '101',
      'X-YouTube-Client-Version': '1.02',
    },
    credentials: 'include',
    body: JSON.stringify({
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'VISIONOS',
          clientVersion: '1.02',
          deviceMake: 'Apple',
          deviceModel: 'RealityDevice17,1',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
          osName: 'visionOS',
          osVersion: '26.5.23O471',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  }, 'json');
  const st = j && j.playabilityStatus && j.playabilityStatus.status;
  if (st && st !== 'OK') {
    throw new Error('视频不可访问: ' + (j.playabilityStatus.reason || st));
  }
  return j;
}

/**
 * 取播放器数据，三条路依次尝试。
 * YouTube 是单页应用：切视频不重载页面，全局变量可能停留在旧视频上，
 * 所以播放器元素优先；但播放器懒加载，所以还要有 script 解析兜底。
 */
function ytPlayerResponse() {
  const current = (r) => r && r.videoDetails && r.videoDetails.videoId === ytVideoId();
  const el = document.getElementById('movie_player');
  if (el && typeof el.getPlayerResponse === 'function') {
    try {
      const r = el.getPlayerResponse();
      if (current(r)) return r;
    } catch (e) { /* 落到下一条 */ }
  }
  const g = window.ytInitialPlayerResponse;
  if (current(g)) return g;
  const scanned = ytScanScripts();
  return current(scanned) ? scanned : null;
}

/** 取不到时给一句能定位问题的说明 */
function ytDiag() {
  const bits = [];
  bits.push(document.getElementById('movie_player') ? '有播放器元素' : '无播放器元素');
  bits.push(window.ytInitialPlayerResponse ? '有全局变量' : '无全局变量');
  let scripts = 0;
  for (const s of document.querySelectorAll('script')) {
    if (s.textContent && s.textContent.indexOf('ytInitialPlayerResponse') >= 0) scripts++;
  }
  bits.push(scripts ? ('页面上有 ' + scripts + ' 处数据脚本') : '页面上没有数据脚本');
  return bits.join(' / ');
}

function ytPickTrack(tracks, prefer) {
  const isAuto = (t) => (t.kind || '') === 'asr';
  if (prefer) {
    const hit = tracks.find((t) => t.languageCode === prefer);
    if (hit) return hit;
  }
  const zh = tracks.filter((t) => /^zh/i.test(t.languageCode || ''));
  const manualZh = zh.find((t) => !isAuto(t));
  if (manualZh) return manualZh;
  const autoZh = zh.find(isAuto);
  if (autoZh) return autoZh;
  const manual = tracks.find((t) => !isAuto(t));
  return manual || tracks[0];
}

/** json3 -> 与 B站统一的 items / text 结构 */
function ytJson3ToText(data, withTs) {
  const items = [];
  for (const ev of (data && data.events) || []) {
    if (!ev || typeof ev.tStartMs !== 'number') continue;
    const t = tidyCjk((ev.segs || []).map((s) => (s && s.utf8) || '').join('').replace(/\s+/g, ' ')).trim();
    if (!t) continue;                        // 纯换行事件
    const from = ev.tStartMs / 1000;
    items.push({ from, to: from + (ev.dDurationMs || 0) / 1000, content: t });
  }
  const blocks = [];
  let buf = [];
  let start = null;
  let lastEnd = null;
  for (const it of items) {
    if (lastEnd !== null && it.from - lastEnd > 2.0 && buf.length) {
      blocks.push({ start, text: buf.reduce((a, b) => smartJoin(a, b), '') });
      buf = [];
      start = null;
    }
    if (start === null) start = it.from;
    buf.push(it.content);
    lastEnd = it.to;
  }
  if (buf.length) blocks.push({ start, text: buf.reduce((a, b) => smartJoin(a, b), '') });

  const cleaned = blocks
    .map((b) => ({ start: b.start, text: tidyCjk(b.text.replace(/\s+/g, ' ')).trim() }))
    .filter((b) => b.text);
  return {
    items,
    text: withTs
      ? cleaned.map((b) => `[${fmtTime(b.start)}] ${b.text}`).join('\n\n')
      : cleaned.map((b) => b.text).join('\n'),
  };
}

async function extractYouTube(opts) {
  const { withTs = true, prefer = '' } = opts || {};
  opts = opts || {};
  const vid = ytVideoId();
  if (!vid) throw new Error('当前页面不是 YouTube 视频页');

  // 字幕地址必须来自 innertube 的 VISIONOS client：
  // 页面 WEB client 给的地址请求会返回 200 + 空体，这是实测踩到的坑。
  // 但匿名 innertube 对部分视频返回 0 条轨道 —— 此时换页面数据再试一次（带登录态可能更多）。
  let pr = null;
  let via = 'innertube';
  let innerNote = '';
  try {
    const cand = await ytInnertubePlayer(vid);
    if (!cand.videoDetails) throw new Error('响应里没有 videoDetails');
    const ct = ((cand.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
    pr = cand;
    if (!ct.length) {
      innerNote = 'innertube 返回 0 条字幕轨道（可能需要 YouTube 登录态），已尝试页面数据';
      const pagePr = ytPlayerResponse();
      const pt = pagePr ? (((pagePr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || []) : [];
      if (pt.length) { pr = pagePr; via = 'page'; }
    }
  } catch (e) {
    innerNote = 'innertube 失败: ' + ((e && e.message) || e) + '，已尝试页面数据';
    via = 'page';
    pr = ytPlayerResponse();
  }
  if (!pr) throw new Error(innerNote + '；页面数据也没取到（' + ytDiag() + '）');

  const vd = pr.videoDetails || {};
  const base = {
    platform: 'youtube',
    bvid: vid,
    title: vd.title || document.title.replace(/ - YouTube$/, ''),
    uploader: vd.author || '',
    duration: Number(vd.lengthSeconds) || 0,
    durationText: fmtTime(Number(vd.lengthSeconds) || 0),
    partTotal: 1,
    partGot: 0,
    chars: 0,
    lan: '',
    isAi: false,
    tracks: [],
    text: '',
    items: [],
    markdown: '',
    missing: [],
    error: '',
    fetchedAt: Date.now(),
  };

  const rc = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
  const trackList = (rc && rc.captionTracks) || [];
  if (!trackList.length) {
    return { ...base, ok: false, error: '这个视频没有字幕（UP主没传，YouTube 也没自动生成）' };
  }

  const track = ytPickTrack(trackList, prefer);
  let url = track.baseUrl || '';
  if (!url) return { ...base, ok: false, error: '字幕地址缺失' };
  // 默认返回 XML，这里统一要 json3
  url = /[?&]fmt=/.test(url)
    ? url.replace(/([?&])fmt=[^&]*/, '$1fmt=json3')
    : url + '&fmt=json3';

  // 非中文字幕 + 勾了「翻译成中文」→ 走 YouTube 的机翻参数
  let tlang = '';
  if (opts.translateCn && !/^zh/i.test(track.languageCode || '')) {
    tlang = 'zh-Hans';
    url += '&tlang=' + tlang;
  }

  let raw = '';
  let requestError = '';
  try { raw = await textGet(url); } catch (e) { requestError = e.message; }
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) { /* 落到播放器捕获兜底 */ }

  if (!data || !(data.events || []).length) {
    // 主路径拿不到内容（WEB client 裸请求 200 + 0 字节）——
    // 触发播放器加载字幕，用 hook 捕获到的真实地址（自带 POT 上下文）重新取。
    ytSyncHookedFromDom();
    ytTriggerCaptionLoad();
    await new Promise((r) => setTimeout(r, 2500));
    ytSyncHookedFromDom();
    const cands = ytHookedUrls.filter((x) => {
      try {
        const u = new URL(x.url);
        return BiliCore.subtitleUrl(u.href) && u.pathname === '/api/timedtext'
          && u.searchParams.get('v') === vid
          && u.searchParams.get('lang') === track.languageCode;
      } catch (_) { return false; }
    });
    const pick = cands.length ? cands[cands.length - 1] : null;
    if (pick) {
      const hookUrl = new URL(pick.url);
      hookUrl.searchParams.set('fmt', 'json3');
      if (tlang) hookUrl.searchParams.set('tlang', tlang);
      else hookUrl.searchParams.delete('tlang');
      let hu = hookUrl.href;
      try {
        const raw2 = await textGet(hu);
        data = JSON.parse(raw2);
        via = 'hook';
      } catch (e) { /* hook 路径也失败 */ }
    }
  }

  if (!data || !(data.events || []).length) {
    return {
      ...base,
      ok: false,
      error: '字幕文件解析失败（via ' + via + '，' + raw.length + ' B，开头 ' +
             JSON.stringify(raw.slice(0, 80)) + '）' + (innerNote ? '；' + innerNote : '') + (requestError ? '；' + requestError : '') +
             '。自助办法：点开播放器右下角的 CC 字幕开关让字幕显示出来，再点一次提取',
    };
  }

  const parsed = ytJson3ToText(data, withTs);
  if (!parsed.text) return { ...base, ok: false, error: '字幕内容为空' };

  const lanDoc = (track.name && track.name.simpleText) || track.languageCode || '';
  const meta = [
    `# ${base.title}`,
    '',
    `- 视频ID: ${vid}`,
    `- 频道: ${base.uploader}`,
    `- 时长: ${base.durationText}`,
    `- 链接: https://www.youtube.com/watch?v=${vid}`,
    `- 字幕来源: ${lanDoc} (${track.languageCode})`,
    `- 抓取时间: ${new Date().toLocaleString('zh-CN')}`,
  ];
  if (vd.shortDescription && vd.shortDescription.trim()) {
    meta.push('', '## 视频简介', '', vd.shortDescription.trim());
  }

  return {
    ...base,
    ok: true,
    partGot: 1,
    chars: parsed.text.replace(/\s/g, '').length,
    lan: tlang || track.languageCode || '',
    lan_doc: (tlang ? '中文（机器翻译）' : lanDoc),
    isAi: (track.kind || '') === 'asr',
    translated: !!tlang,
    withTs,
    tracks: trackList.map((t) => ({
      lan: t.languageCode,
      doc: (t.name && t.name.simpleText) || t.languageCode,
      ai: (t.kind || '') === 'asr',
    })),
    text: parsed.text,
    items: parsed.items,
    markdown: meta.join('\n') + '\n\n---\n\n' + parsed.text,
  };
}

// ==================================================== 平台分发

// MAIN world 的 inject_hook.js 会把播放器发出的 timedtext 地址 postMessage 过来，
// 这里缓存起来 —— 这是 YouTube 字幕最可靠的来源（地址自带播放器的 POT 等上下文）。
const ytHookedUrls = [];

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== 'bili-tx-hook' || d.type !== 'timedtext') return;
  if (!d.url || !BiliCore.subtitleUrl(d.url)) return;
  if (ytHookedUrls.some((x) => x.url === d.url)) return;
  ytHookedUrls.push({ url: d.url, at: d.at || Date.now() });
  if (ytHookedUrls.length > 30) ytHookedUrls.shift();
});

/** 早期捕获兜底：hook 脚本在页面加载极早期就可能捕到地址（早于本脚本注入），
 *  它同时会把列表写在 DOM dataset 上，每次提取前同步一份，保证不漏。 */
function ytSyncHookedFromDom() {
  try {
    const raw = document.documentElement.dataset.biliTxUrls;
    if (!raw) return;
    for (const x of JSON.parse(raw)) {
      if (x && BiliCore.subtitleUrl(x.url) && !ytHookedUrls.some((y) => y.url === x.url)) ytHookedUrls.push(x);
      if (ytHookedUrls.length > 30) ytHookedUrls.shift();
    }
  } catch (e) { /* dataset 缺失或格式异常则忽略 */ }
}

/** 让播放器把字幕加载出来（触发 timedtext 请求，从而被 hook 捕获） */
function ytTriggerCaptionLoad() {
  const btn = document.querySelector('.ytp-subtitles-button');
  if (btn && !btn.getAttribute('aria-pressed')?.includes('true') && !btn.disabled) {
    try { btn.click(); } catch (e) { /* ignore */ }
    return true;
  }
  try {
    const p = document.getElementById('movie_player');
    if (p && typeof p.setOption === 'function') {
      p.setOption('captions', 'track', { languageCode: 'zh' });
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

const ADAPTERS = [
  {
    name: 'bilibili',
    match: (u) => /bilibili\.com\/(video|list|bangumi\/play)\//.test(u),
    extract: extractBilibili,
  },
  {
    name: 'youtube',
    match: (u) => /youtube\.com\/(watch|shorts\/)/.test(u),
    extract: extractYouTube,
  },
];

async function extractAll(opts) {
  const url = location.href;
  const ad = ADAPTERS.find((a) => a.name === BiliCore.platform(url));
  if (!ad) throw new Error('当前页面不是支持的视频页（目前支持 B站 与 YouTube）');
  const result = await ad.extract(opts);
  if (location.href !== url) throw new Error('提取期间视频地址发生变化，请在当前视频重新提取');
  return result;
}

// 防止重复注入（manifest 自动注入 + popup 兜底注入可能同时发生），
// 否则同一个消息会被处理多次、响应错乱。
if (!window.__biliTxInjected) {
  window.__biliTxInjected = true;
  let extracting = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'PING') {
      sendResponse({ ok: true, bvid: getBvid(), title: document.title });
      return false;
    }
    if (msg && msg.type === 'EXTRACT') {
      if (extracting) { sendResponse({ ok: false, error: '字幕正在提取，请稍候再试' }); return false; }
      extracting = true;
      extractAll(msg.opts)
        .then((r) => sendResponse({ ok: true, data: r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
        .finally(() => { extracting = false; });
      return true; // 异步响应
    }
    return false;
  });
}

})();

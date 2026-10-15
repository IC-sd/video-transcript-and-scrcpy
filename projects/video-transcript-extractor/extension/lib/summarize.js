/**
 * summarize.js —— 本地内容分析引擎（浏览器版）
 *
 * 与 Python 版算法一致，但分词改用浏览器原生的 Intl.Segmenter（ICU 中文分词），
 * 因此整个扩展零第三方依赖、零外部请求。
 *
 * 关键适配：B站 AI 字幕几乎没有标点，按标点分句切不动、按长度硬切会腰斩句子，
 * 所以分句以**字幕条目边界**为准，攒到 ~30 字再断。
 */
(function (global) {
  'use strict';

  const STOPWORDS = new Set(`的 了 是 在 我 有 和 就 不 人 都 一 上 也 很 到 说 要 去 你 会 着 看 好 自己 这 那 他 她 它
我们 你们 他们 咱们 这个 那个 什么 怎么 为什么 但是 因为 所以 然后 而且 就是 对吧 啊 呢 吧 吗 嗯 呃 哦 哈 呀
这样 那样 可以 可能 应该 一些 这些 那些 现在 时候 事情 东西 问题 地方 方式 情况 大家 如果 或者 还是 已经
也是 不是 这种 那种 出来 起来 过来 下去 一下 一点 非常 特别 真的 其实 只是 还有 一样 觉得 知道 明白 意思
让 给 把 被 从 对 向 跟 及 与 或 但 并 而 之 其 此 该 各 每 某 等 比较 那么 这里 那里 上面 下面 前面 后面
里面 外面 之前 之后 以后 以前 同时 另外 比如 举例 一个 很多 没有 不能 不要 不会 没法 一次 一直 一定 别的
全部 所有 每个 某种 怎么样 什么样 老师 同学 各位 视频 内容 部分 方面 程度 结果 原因 样子 感觉 认为 有点
根本 简直 居然 反正 越来越 这么 真是 好像 差不多 基本上
你要 我要 他有 都有 你有 它有 咱们 什么 怎么 这个 那个 现在 时候 或者 如果 因为 所以 但是`.split(/\s+/).filter(Boolean));

  const FILLERS = ['就是', '对吧', '然后', '其实', '这个', '那么', '很多', '没有', '一个',
    '可能', '应该', '我们', '大家', '知道', '觉得'];

  const SENT_END = /[。！？!?；;…]$/;
  const PUNCT_SPLIT = /(?<=[。！？!?；;…])/;
  const CLAUSE_SPLIT = /(?<=[，,、])/;
  const CLEAN = /[^\u4e00-\u9fa5A-Za-z0-9]/g;
  const ALNUM = /^[A-Za-z0-9\-_.+]+$/;
  // 纯虚词后缀，只去掉这些，避免误伤"需要""主要"这类实词
  const TAIL_PARTICLES = /[的了是在和就都也与及之其着过]+$/;

  let _seg = null;
  function segmenter() {
    if (!_seg) {
      try {
        _seg = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
      } catch (e) {
        _seg = null;
      }
    }
    return _seg;
  }

  /** 中文分词。Segmenter 不可用时退化为 2/3-gram。 */
  function cut(text) {
    const seg = segmenter();
    const out = [];
    if (seg) {
      for (const s of seg.segment(text)) {
        if (s.isWordLike) out.push(s.segment);
      }
      return out;
    }
    for (const token of String(text).replace(CLEAN, ' ').split(/\s+/)) {
      if (!token) continue;
      if (/^[A-Za-z0-9]+$/.test(token)) {
        out.push(token.toLowerCase());
      } else {
        for (const n of [2, 3]) {
          for (let i = 0; i + n <= token.length; i++) out.push(token.slice(i, i + n));
        }
      }
    }
    return out;
  }

  function norm(w) {
    w = String(w).trim();
    if (ALNUM.test(w)) return w.toLowerCase();
    // Intl.Segmenter 的粒度比 jieba 粗，常把"你的""写的"这类虚词后缀粘在词上。
    // 去掉尾部的纯虚词；若剩下的不足 2 字，后续 validWord 会把它滤掉。
    if (w.length >= 2) {
      const t = w.replace(TAIL_PARTICLES, '');
      if (t.length < w.length) return t;
    }
    return w;
  }

  function validWord(w) {
    if (!w || w.length < 2) return false;
    if (STOPWORDS.has(w)) return false;
    if (/^\d+$/.test(w)) return false;
    if (String(w).replace(CLEAN, '') !== w && !ALNUM.test(w)) return false;
    return true;
  }

  function wordWeights(text) {
    const c = new Map();
    for (let w of cut(text)) {
      w = norm(w);
      if (validWord(w)) c.set(w, (c.get(w) || 0) + 1);
    }
    return c;
  }

  function freq(counter, w) {
    return counter.get(w) || 0;
  }

  /** 把带 [MM:SS] 前缀的文稿解析成 [{sec, text}] */
  function parseSegments(text) {
    const out = [];
    for (const block of String(text).split('\n\n')) {
      const b = block.trim();
      if (!b) continue;
      const m = b.match(/^\[(\d+):(\d+)(?::(\d+))?\]\s*([\s\S]*)$/);
      if (m) {
        const sec = m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
        out.push({ sec, text: m[4].trim() });
      } else {
        out.push({ sec: null, text: b });
      }
    }
    return out;
  }

  /** 按字幕条目边界攒句 */
  function sentencesFromItems(items, target) {
    target = target || 30;
    const out = [];
    let buf = '';
    let start = null;
    for (const it of items || []) {
      const c = (it.content || '').trim();
      if (!c) continue;
      if (start === null) start = it.from || 0;
      buf += c;
      if (buf.length >= target && SENT_END.test(buf)) {
        out.push({ sec: start, text: buf });
        buf = '';
        start = null;
      } else if (buf.length >= target * 1.8) {
        out.push({ sec: start, text: buf });
        buf = '';
        start = null;
      }
    }
    if (buf) out.push({ sec: start === null ? 0 : start, text: buf });
    return out;
  }

  /** 标点优先分句（用于本身带标点的文稿） */
  function splitSentences(text, minLen, maxLen) {
    minLen = minLen || 8;
    maxLen = maxLen || 90;
    const out = [];
    for (const raw of String(text).split(PUNCT_SPLIT)) {
      const p = (raw || '').trim();
      if (!p) continue;
      if (p.length <= maxLen) {
        if (p.length >= minLen) out.push(p);
        continue;
      }
      for (let chunk of p.split(CLAUSE_SPLIT)) {
        chunk = chunk.trim();
        while (chunk.length > maxLen) {
          let at = Math.max(chunk.lastIndexOf('，', maxLen), chunk.lastIndexOf(',', maxLen));
          if (at < minLen) at = maxLen;
          const seg = chunk.slice(0, at + 1).trim();
          if (seg.length >= minLen) out.push(seg);
          chunk = chunk.slice(at + 1).trim();
        }
        if (chunk.length >= minLen) out.push(chunk);
      }
    }
    return out;
  }

  function buildSentences(segs, items) {
    if (items && items.length) return sentencesFromItems(items);
    const out = [];
    for (const s of segs) {
      for (const t of splitSentences(s.text)) out.push({ sec: s.sec, text: t });
    }
    return out;
  }

  function scoreSentence(sent, weights) {
    const ws = cut(sent).map(norm).filter(validWord);
    if (!ws.length) return 0;
    let total = 0;
    for (const w of ws) total += freq(weights, w);
    const uniq = new Set(ws).size;
    return (total / Math.sqrt(ws.length)) * (1 + 0.15 * uniq);
  }

  function similar(a, b, threshold) {
    threshold = threshold === undefined ? 0.55 : threshold;
    const sa = new Set(cut(a).map(norm).filter(validWord));
    const sb = new Set(cut(b).map(norm).filter(validWord));
    if (!sa.size || !sb.size) return false;
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    return inter / Math.min(sa.size, sb.size) >= threshold;
  }

  function dedupe(cands, limit, threshold) {
    const picked = [];
    for (const [sc, sent] of cands) {
      if (picked.some((p) => similar(sent, p[1], threshold))) continue;
      picked.push([sc, sent]);
      if (picked.length >= limit) break;
    }
    return picked;
  }

  function fmt(sec) {
    if (sec === null || sec === undefined) return '--:--';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  function summarize(opts) {
    const { title, uploader, duration, text, items } = opts;
    const keyCount = opts.keyCount || 15;
    const pointCount = opts.pointCount || 8;
    const segMinutes = opts.segMinutes || 2.5;

    const segs = parseSegments(text);
    const sentences = buildSentences(segs, items);

    const plain = sentences.map((s) => s.text).join(' ') || segs.map((s) => s.text).join(' ');
    const chars = plain.replace(/\s/g, '').length;

    const weights = wordWeights(plain);
    const rawFreq = new Map();
    for (let w of cut(plain)) {
      w = norm(w);
      rawFreq.set(w, (rawFreq.get(w) || 0) + 1);
    }
    const topWords = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, keyCount);

    const scored = sentences
      .map((s, i) => ({ sc: scoreSentence(s.text, weights), idx: i, sec: s.sec, text: s.text }))
      .sort((a, b) => b.sc - a.sc);

    const top = dedupe(scored.map((s) => [s.sc, s.text]), pointCount);
    const idxOf = new Map();
    sentences.forEach((s, i) => idxOf.set(s.text, i));
    const topSorted = top.slice().sort((a, b) => (idxOf.get(a[1]) || 0) - (idxOf.get(b[1]) || 0));

    // 时间轴大纲
    const total = duration || Math.max(1, ...segs.map((s) => s.sec || 0));
    const nSeg = Math.max(3, Math.min(12, Math.ceil(total / (segMinutes * 60))));
    const span = total / nSeg;
    const outline = [];
    for (let i = 0; i < nSeg; i++) {
      const lo = i * span;
      const hi = (i + 1) * span;
      const bucket = sentences
        .map((s, idx) => ({ idx, sec: s.sec, text: s.text }))
        .filter((s) => s.sec !== null && s.sec >= lo && s.sec < hi);
      if (!bucket.length) continue;
      const bs = bucket
        .map((s) => ({ sc: scoreSentence(s.text, weights), idx: s.idx, text: s.text }))
        .sort((a, b) => b.sc - a.sc);
      const picked = dedupe(bs.map((s) => [s.sc, s.text]), 2, 0.5);
      picked.sort((a, b) => (idxOf.get(a[1]) || 0) - (idxOf.get(b[1]) || 0));
      outline.push({
        start: Math.floor(lo),
        end: Math.floor(Math.min(hi, total)),
        points: picked.map((p) => p[1]),
      });
    }

    let fillTotal = 0;
    for (const w of FILLERS) fillTotal += rawFreq.get(w) || 0;
    const fillRate = +(fillTotal / Math.max(chars, 1) * 100).toFixed(1);
    const headline = top.length ? top[0][1] : '';
    const speed = duration ? Math.round(chars / Math.max(duration / 60, 0.1)) : 0;

    const L = [];
    L.push(`# ${title} —— 内容总结`, '');
    L.push(`> UP主 **${uploader}** · 时长 **${fmt(duration)}** · 文稿 **${chars} 字** · 语速约 **${speed} 字/分钟**`, '');
    L.push('*本地分析引擎生成（Intl.Segmenter 分词 + TF 权重 + 句子重要性排序 + 相似句去重），未调用任何外部服务。*', '');
    if (headline) L.push('## 一句话概括', '', `> ${headline}`, '');
    if (topWords.length) L.push('## 核心关键词', '', topWords.map(([w, c]) => `\`${w}\`×${c}`).join(' · '), '');
    if (outline.length) {
      L.push('## 时间轴大纲', '');
      for (const o of outline) {
        L.push(`### ${fmt(o.start)} – ${fmt(o.end)}`);
        for (const p of o.points) L.push(`- ${p}`);
        L.push('');
      }
    }
    if (topSorted.length) {
      L.push('## 核心观点', '');
      topSorted.forEach((p, i) => L.push(`${i + 1}. ${p[1]}`));
      L.push('');
    }
    if (topWords.length) {
      L.push('## 高频实词', '', '| 词 | 次数 | 词 | 次数 | 词 | 次数 |', '|---|---|---|---|---|---|');
      const ws = topWords.slice(0, 18);
      for (let i = 0; i < ws.length; i += 3) {
        const row = ws.slice(i, i + 3);
        while (row.length < 3) row.push(['', '']);
        L.push('| ' + row.map(([w, c]) => (w ? `${w} | ${c}` : ' | ')).join(' | ') + ' |');
      }
      L.push('');
    }
    L.push('## 表达特征', '',
      `- 口头填充词 **${fillTotal}** 处，占文稿 **${fillRate}%**${fillRate > 4 ? '（口语化偏重，信息密度偏低）' : '（口语化程度正常）'}`,
      `- 共 **${sentences.length}** 个语义段落，平均每段 **${Math.round(chars / Math.max(sentences.length, 1))}** 字`,
      '');

    return {
      markdown: L.join('\n'),
      headline,
      keywords: topWords.map(([w, c]) => ({ word: w, count: c })),
      points: topSorted.map((p) => p[1]),
      outline,
      chars,
      speed,
      fillerRate: fillRate,
      segments: sentences.length,
    };
  }

  global.BiliSummarize = { summarize, cut, fmt };
})(typeof window !== 'undefined' ? window : self);

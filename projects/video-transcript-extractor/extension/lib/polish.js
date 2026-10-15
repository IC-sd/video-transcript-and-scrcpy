/**
 * polish.js —— 把口语字幕整理成"能读的文稿"
 *
 * B站字幕（尤其 AI 字幕）的典型毛病：
 *   · 完全没有标点，几百字连成一片
 *   · 大量语气词与口头禅（啊/吧/呢/嗯/对吧/就是说）
 *   · 口误与重复（"他怎么越来越偏了呢他怎么越来越偏呢"）
 *   · 句子按时间切片，可能切在词中间（"未|来"）
 *
 * 本模块只做「可读化」，不做摘要、不压缩信息：
 *   去口头禅 → 去语气词 → 去重复口误 → 补标点断句 → 分段成文
 *
 * 三个关键设计：
 *   1. 所有清洗都在**拼好的全文**上做，不能逐条做 —— 口头禅常被条目边界切开
 *      （「就是」+「说」），逐条处理会漏。
 *   2. 清洗时同步维护"字符位置 → 时间"的映射数组，删字符就同步 splice，
 *      这样最后仍能给出准确的段落时间锚点。
 *   3. 断句只在**分词后的词边界**上落句号，从机制上排除「未。来」这类错误。
 */
(function (global) {
  'use strict';

  let _seg = null;
  function segmenter() {
    if (_seg === null) {
      try {
        _seg = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
      } catch (e) {
        _seg = false;
      }
    }
    return _seg || null;
  }

  // 独立成词时才删的语气词。刻意保守 —— 语义连接词（但是/所以/如果/因为）
  // 和可能承载实义的词一律保留，避免把意思删掉。
  const FILLER_WORDS = new Set(`啊 吧 呢 嗯 呃 呀 哦 唉 诶 嘛 噢 喔 哎 哈 呵 嘿 唔 咦 呐 哟
    呃呃 嗯嗯 啊啊 哦哦 哈哈 呵呵`.split(/\s+/).filter(Boolean));

  // 作为子串清理的口头禅（出现频率高、删掉不影响语义）
  const FILLER_PATTERNS = [
    /对吧/g, /是吧/g, /对不对/g, /是不是/g, /好不好/g, /行不行/g,
    /我跟你讲/g, /你知道吧/g, /你懂吧/g, /你懂我意思吧/g, /就是说/g,
    /这个这个/g, /那个那个/g, /的话/g,
  ];

  const SENT_END = /[。！？!?；;….]$/;
  // 疑问语气收尾 → 句号改问号（保守只列强疑问词，「是吧/对吧」仍按陈述处理）
  const QUESTION_END = /(吗|么|呢|什么|怎么|怎样|为什么|为何|如何|多少|哪里|哪个|谁)$/
  const CONNECT = /(但是|可是|所以|不过|另外|而且|因为|如果|虽然|因此|并且|然后)/;
  // 这些字作句尾时后面必须还有内容，在这里断句会读成「跟。大家」
  const NEEDS_TAIL = /[跟和把给在从对向为被让使与同到就都也还很更最不没要会能可把于]/;
  // 词级同理：「比如。说」「虽然。但是」都读不通
  const NEEDS_TAIL_WORD = /(比如|例如|像是|如果|因为|所以|但是|而且|就是|还是|这样|那样|关于|至于|由于|为了|按照|根据|通过|也就是说|或者说|一般|大概|可能|其实|主要|确实|就是)$/;
  // 这些单字在口语里常被重复说两遍（「在在」「我我」），但都不是正常叠词，重复即口误
  const DUP_CHARS = '我你他她在是的了就都有和这那很也不没要会能对吧啊呢嘛';

  /**
   * 归一化空白：中文（含全角标点）之间的空格去掉（中文不分词用空格），
   * 但拉丁字母/数字之间的空格必须保留 —— 否则 "AI agent" 会变成 "AIagent"。
   */
  function tidySpaces(s) {
    let out = String(s || '').replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    let prev;
    do {
      prev = out;
      out = out.replace(/([\u4e00-\u9fa5\u3040-\u30ff\uff00-\uffef]) +([\u4e00-\u9fa5\u3040-\u30ff\uff00-\uffef])/g, '$1$2');
    } while (out !== prev);
    return out;
  }

  /** 按升序的区间列表从后往前删除，避免索引错乱；times 同步删除 */
  function spliceOut(text, times, ranges) {
    for (let i = ranges.length - 1; i >= 0; i--) {
      const s = ranges[i][0];
      const e = ranges[i][1];
      text = text.slice(0, s) + text.slice(e);
      times.splice(s, e - s);
    }
    return text;
  }

  function normRanges(ranges) {
    ranges.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of ranges) {
      if (r[1] <= r[0]) continue;
      if (out.length && r[0] < out[out.length - 1][1]) continue;
      out.push(r);
    }
    return out;
  }

  /** 删多字口头禅（必须在删单字语气词之前做，否则「对吧」会先被拆成「对」+「吧」） */
  function dropPhrases(text, times) {
    for (const re of FILLER_PATTERNS) {
      const ranges = [];
      re.lastIndex = 0;
      let m;
      let guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 2000) {
        ranges.push([m.index, m.index + m[0].length]);
      }
      const merged = normRanges(ranges);
      if (merged.length) text = spliceOut(text, times, merged);
    }
    return text;
  }

  /** 删独立成词的语气词。分词保证不会切掉实词的一部分。 */
  function dropFillerWords(text, times) {
    const seg = segmenter();
    if (!seg) {
      let t = text;
      for (const w of FILLER_WORDS) t = t.split(w).join('');
      return t;
    }
    const ranges = [];
    for (const s of seg.segment(text)) {
      if (s.isWordLike && FILLER_WORDS.has(s.segment)) {
        ranges.push([s.index, s.index + s.segment.length]);
      }
    }
    return spliceOut(text, times, normRanges(ranges));
  }

  /** 去重复口误：长重复短语、连续重复短词、单字三连以上 */
  function dropRepeats(text, times) {
    const RES = [
      /([\u4e00-\u9fa5]{4,12})\1/g,                    // "越来越偏越来越偏"
      /([\u4e00-\u9fa5]{2,3})\1/g,                     // "很多很多"
      /([\u4e00-\u9fa5])\1{2,}/g,                      // "你你你"
      new RegExp('([' + DUP_CHARS + '])\\1', 'g'),     // "在在""我我" —— 虚词重复即口误
    ];
    for (let round = 0; round < 3; round++) {
      let hit = false;
      for (const re of RES) {
        const ranges = [];
        re.lastIndex = 0;
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null && guard++ < 2000) {
          // 只删重复的那一半
          ranges.push([m.index + m[1].length, m.index + m[0].length]);
        }
        const merged = normRanges(ranges);
        if (merged.length) {
          text = spliceOut(text, times, merged);
          hit = true;
        }
      }
      if (!hit) break;
    }
    return text;
  }

  // 内置的同音字纠错表（ASR 常见错；领域相关的由用户在设置里自定义补充）
  const BUILTIN_TERM_FIXES = [
    ['全蛋', '全栈'],
    ['招转赔贷', '招转倍贷'],
  ];

  /** 解析用户词典文本：每行一条「错误=正确」（也接受 ： / -> / → 分隔） */
  function parseFixes(str) {
    const out = [];
    for (const line of String(str || '').split('\n')) {
      const m = line.split(/=|：|->|→/);
      if (m.length >= 2 && m[0].trim() && m[1].trim()) out.push([m[0].trim(), m[1].trim()]);
    }
    return out;
  }

  /** 按词典做同音字纠错。替换会改变长度，times 同步维护，段落时间锚点不受影响。 */
  function fixTerms(text, times, pairs) {
    for (const pair of pairs) {
      const wrong = pair[0];
      const right = pair[1];
      if (!wrong || wrong === right) continue;
      let idx = text.indexOf(wrong);
      let guard = 0;
      while (idx >= 0 && guard++ < 2000) {
        const oldLen = wrong.length;
        const newLen = right.length;
        if (oldLen > newLen) {
          times.splice(idx + newLen, oldLen - newLen);
        } else if (newLen > oldLen) {
          const fill = times[idx] || { from: 0, to: 0 };
          const extra = [];
          for (let k = 0; k < newLen - oldLen; k++) extra.push(fill);
          times.splice.apply(times, [idx, 0].concat(extra));
        }
        text = text.slice(0, idx) + right + text.slice(idx + oldLen);
        idx = text.indexOf(wrong, idx + newLen);
      }
    }
    return text;
  }

  /**
   * 断句。优先级：已有句末标点 > 时间停顿 > 长度足够。
   * 只在分词后的词边界落句号，因此不会出现「未。来」。
   */
  function buildSentences(text, times, opts) {
    opts = opts || {};
    const soft = opts.soft || 42;
    const hard = opts.hard || 115;
    const gapSec = opts.gap || 0.7;
    if (!text) return [];

    const seg = segmenter();
    const tokens = [];
    if (seg) {
      for (const s of seg.segment(text)) {
        tokens.push({ w: s.segment, start: s.index, end: s.index + s.segment.length, word: s.isWordLike });
      }
    } else {
      for (let i = 0; i < text.length; i++) tokens.push({ w: text[i], start: i, end: i + 1, word: true });
    }

    const out = [];
    let buf = '';
    let from = null;
    let start = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (from === null) { from = (times[tk.start] || {}).from || 0; start = tk.start; }
      buf += tk.w;

      const cur = times[tk.end - 1] || {};
      const nxt = tokens[i + 1];
      const gap = nxt ? ((times[nxt.start] || {}).from || 0) - (cur.to || 0) : 0;
      // 下一个词是单字时，多半要和后面连读（「在路上|了」），这里不该断
      const nextIsTight = !!(nxt && nxt.word && nxt.w.length === 1 && !/[。，！？]/.test(nxt.w));
      const okBreak = !nextIsTight
        && !NEEDS_TAIL.test(buf.slice(-1))
        && !NEEDS_TAIL_WORD.test(buf);
      // 下一个词是连接词 → 这里是语义转折点，断句最自然
      const beforeConnect = !!(nxt && CONNECT.test(nxt.w));

      if (!nxt
          || SENT_END.test(buf)
          || (opts.questionBreak !== false && buf.length >= 6 && /[吗呢]$/.test(buf) && okBreak && !/^[。！？!?]/.test(nxt?.w || ''))
          || (gap >= gapSec && buf.length >= 10 && okBreak)
          || (buf.length >= hard && okBreak)
          || buf.length >= hard * 1.6) {   // 兜底：再长也不能不断
        out.push({ text: buf, from, start, end: tk.end });
        buf = '';
        from = null;
      } else if (buf.length >= soft && okBreak && beforeConnect) {
        // 只在连接词前断 —— 靠纯长度硬断会断在「你要开始|培养」这种语义中间
        out.push({ text: buf, from, start, end: tk.end });
        buf = '';
        from = null;
      }
    }
    if (buf) out.push({ text: buf, from: from === null ? 0 : from, start, end: text.length });
    return out;
  }

  // 逗号插入点的排除项：前面若已是这些结构，再加逗号反而读着别扭
  const NO_COMMA_BEFORE = /(就是|还是|但是|因为|所以|如果|而且|或者|只是|总是|要是|于是)$/;

  function punctuate(text) {
    let s = String(text).trim();
    if (!s) return '';
    s = s.replace(/^[，、；：]+/, '').replace(/[，、；：]+$/, '');
    if (s.length >= 18 && CONNECT.test(s)) {
      s = s.replace(
        new RegExp('([^。，！？；：]{5,}?)' + CONNECT.source, 'g'),
        (m, p1, p2) => (NO_COMMA_BEFORE.test(p1) ? m : p1 + '，' + p2)
      );
    }
    if (!SENT_END.test(s)) s += /[\u4e00-\u9fff]/.test(s) ? (QUESTION_END.test(s) ? '？' : '。') : '.';
    return s;
  }

  /** 分段：按字数凑（220–460 字一段），同时不让单段句子过多 */
  function groupParagraphs(sentences, minChars, maxChars) {
    const paras = [];
    let buf = [];
    let len = 0;
    for (const s of sentences) {
      buf.push(s);
      len += s.text.length;
      if (len >= maxChars || (len >= minChars && buf.length >= 3)) {
        paras.push(buf);
        buf = [];
        len = 0;
      }
    }
    if (buf.length) paras.push(buf);
    return paras;
  }

  function fmt(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  /**
   * @param {{from:number,to:number,content:string}[]} items 字幕条目
   * @param {{soft?:number,hard?:number,gap?:number,minChars?:number,maxChars?:number,withTime?:boolean}} opts
   */
  function polish(items, opts) {
    opts = opts || {};
    const list = (items || []).filter((it) => (it.content || '').trim());
    const rawChars = list.reduce((n, it) => n + (it.content || '').replace(/\s/g, '').length, 0);

    // 拼成全文，同时维护 字符位置 → 时间 的映射
    let text = '';
    const times = [];
    for (const it of list) {
      const c = { from: it.from || 0, to: typeof it.to === 'number' ? it.to : (it.from || 0) + 3 };
      const segment = tidySpaces(it.content);
      const needsSpace = text && segment && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(segment);
      const t = (needsSpace ? ' ' : '') + segment;
      for (let i = 0; i < t.length; i++) times.push(c);
      text += t;
    }

    // 同音字/术语纠错（纠错不是改写，keepFillers 模式也生效；词典 = 内置 + 用户自定义）
    if (opts.useTermFix !== false) {
      const pairs = parseFixes(opts.termFixes).concat(opts.keepFillers ? [] : BUILTIN_TERM_FIXES)
        .sort((a, b) => b[0].length - a[0].length);
      if (pairs.length) text = fixTerms(text, times, pairs);
    }

    // 清洗（顺序不能变）。keepFillers 模式用于「转录文字」：保留原文用词（含语气词），只补标点分段。
    const lenBefore = text.length;
    if (!opts.keepFillers) {
      text = dropPhrases(text, times);
      text = dropFillerWords(text, times);
      text = dropRepeats(text, times);
    }
    const removedChars = opts.keepFillers ? 0 : Math.max(0, lenBefore - text.length);

    // 断句 + 补标点
    let sentences = buildSentences(text, times, opts)
      .map((s) => ({ from: s.from, text: punctuate(s.text) }))
      .filter((s) => opts.keepFillers ? !!s.text.trim() : s.text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length >= 4);

    // 相邻相似句去重（口误常表现为把同一句说两遍）
    const seen = [];
    sentences = sentences.filter((s) => {
      if (opts.keepFillers) return true;
      const g = grams(s.text);
      if (g.size) {
        for (let i = seen.length - 1; i >= Math.max(0, seen.length - 2); i--) {
          const b = seen[i];
          let inter = 0;
          for (const x of g) if (b.has(x)) inter++;
          if (inter / Math.min(g.size, b.size) >= 0.72) return false;
        }
      }
      seen.push(g);
      return true;
    });

    const paras = groupParagraphs(sentences, opts.minChars || 220, opts.maxChars || 460);
    const bodyChars = sentences.reduce((n, s) => n + s.text.length, 0);

    return {
      paragraphs: paras.map((p) => {
        const head = opts.withTime && p[0] ? '[' + fmt(p[0].from) + '] ' : '';
        return head + p.map((s) => s.text).reduce((all, s) => all + (all && /^[A-Za-z0-9]/.test(s) ? ' ' : '') + s, '');
      }),
      sentences: sentences.map((s) => s.text),
      stats: {
        rawChars,
        removedChars,          // 清洗阶段真正删掉的字数（不含后补的标点）
        outChars: bodyChars,
        sentenceCount: sentences.length,
        paragraphCount: paras.length,
      },
    };
  }

  function grams(s) {
    const set = new Set();
    const t = String(s).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
    return set;
  }

  /** Conservative cleanup: fillers and exact repetition, never fuzzy semantic deletion. */
  function clean(items, opts = {}) {
    let text = '';
    const times = [];
    for (const item of items || []) {
      const content = tidySpaces(item.content);
      if (!content) continue;
      const separator = text && /[A-Za-z0-9.!?]$/.test(text) && /^[A-Za-z0-9]/.test(content) ? ' ' : '';
      const mapped = separator + content;
      const timing = { from: Number(item.from) || 0, to: Number(item.to) || Number(item.from) || 0 };
      text += mapped;
      for (let i = 0; i < mapped.length; i++) times.push(timing);
    }
    const rawChars = text.replace(/\s/g, '').length;
    const userFixes = parseFixes(opts.termFixes).sort((a, b) => b[0].length - a[0].length);
    text = fixTerms(text, times, userFixes);
    let fillerChars = 0, repeatCount = 0, discardedCount = 0;
    function remove(value, mapping, regex, group = 0, wordSafe = false) {
      const ranges = [];
      const tokens = wordSafe && segmenter() ? [...segmenter().segment(value)] : [];
      for (const match of value.matchAll(regex)) {
        const offset = group ? match[0].indexOf(match[group], (match[1] || '').length) : 0;
        const start = match.index + offset, end = start + match[group].length;
        if (tokens.some((token) => (token.index < start && token.index + token.segment.length > start)
            || (token.index < end && token.index + token.segment.length > end))) continue;
        ranges.push([start, end]);
      }
      const cleanRanges = normRanges(ranges);
      fillerChars += cleanRanges.reduce((n, [a, b]) => n + b - a, 0);
      return spliceOut(value, mapping, cleanRanges);
    }
    // Merge verbatim stutters spanning subtitle entries, without altering numbers or negation.
    for (let round = 0; round < 3; round++) {
      const ranges = [];
      for (const match of text.matchAll(/([\u4e00-\u9fff]{4,40})\1/gu)) {
        ranges.push([match.index + match[1].length, match.index + match[0].length]);
      }
      for (const match of text.matchAll(/([\u4e00-\u9fff]{4,60})[，,、]\s*\1/gu)) {
        ranges.push([match.index + match[1].length, match.index + match[0].length]);
      }
      for (const match of text.matchAll(/(这个|那个|就是|然后|所以|但是|我们|你们|我认为|我觉得)[，,、\s]*\1/gu)) {
        ranges.push([match.index + match[1].length, match.index + match[0].length]);
      }
      for (const match of text.matchAll(/([我你这那])\1+/gu)) {
        ranges.push([match.index + 1, match.index + match[0].length]);
      }
      for (const match of text.matchAll(/\b([A-Za-z]{2,})[ \t]+\1\b/giu)) {
        ranges.push([match.index + match[1].length, match.index + match[0].length]);
      }
      const cleanRanges = normRanges(ranges);
      if (!cleanRanges.length) break;
      repeatCount += cleanRanges.length;
      text = spliceOut(text, times, cleanRanges);
    }
    const recent = [];
    const kept = [];
    for (const sentence of buildSentences(text, times, { ...opts, questionBreak: false, soft: 80, hard: 180 })) {
      let value = sentence.text;
      const question = /[?？]/.test(value) || QUESTION_END.test(value.replace(/[。！？!?；;.\s]+$/g, ''));
      const mapping = times.slice(sentence.start, sentence.end);
      value = remove(value, mapping, /(^|[，,。！？!?；;]\s*)(大家好|各位好|朋友们好|同学们好|欢迎(?:来到|回到)(?:我的|我们的)?(?:频道|直播间))(?=[，,、\s]*[\p{L}\p{N}])/gu, 2, true);
      value = remove(value, mapping, /(^|[.!?]\s*)(hello everyone|hi everyone)(?=[,\s]+[A-Za-z])/giu, 2);
      // These words are removed only at speech boundaries. "如果…的话" and "是不是可行" stay intact.
      value = remove(value, mapping, /(^|[，,。！？!?；;]\s*)(就是说|我跟你讲|你知道吧|怎么说呢|那个那个|这个这个)[，,、\s]*/gu, 2, true);
      value = remove(value, mapping, /(^|[，,。！？!?；;]\s*)(这个|那个)(?=[，,、\s])/gu, 2);
      value = remove(value, mapping, /(^|[\s,，.!?。！？;；])((?:um+|uh+|erm+)(?:\b)[,，\s]*)/giu, 2);
      value = remove(value, mapping, /(^|[,，]\s*)(you know)(?=[,，.!?\s]|$)/giu, 2);
      value = remove(value, mapping, /([，,]\s*)((?:对吧|是吧|对不对|好不好|行不行|明白了吗|懂了吗))(?=[。！？!?\s]*$)/gu, 2);
      value = remove(value, mapping, /(对吧|是吧)(?=[。！？!?\s]*$)/gu);
      const seg = segmenter();
      const ranges = [];
      if (seg) {
        for (const token of seg.segment(value)) {
          if (token.isWordLike && FILLER_WORDS.has(token.segment)) ranges.push([token.index, token.index + token.segment.length]);
        }
      } else {
        // Avoid substring removal (e.g. deleting part of a name) when no segmenter is available.
        for (const match of value.matchAll(/(^|[，,。！？!?；;\s])([嗯呃哦啊]+)(?=[，,。！？!?；;\s]|$)/gu)) {
          ranges.push([match.index + match[1].length, match.index + match[0].length]);
        }
      }
      fillerChars += ranges.reduce((n, [a, b]) => n + b - a, 0);
      value = spliceOut(value, mapping, normRanges(ranges));
      // Conversational tags, not substantive questions about correctness or feasibility.
      value = remove(value, mapping, /([，,]\s*)((?:对吧|是吧|对不对|好不好|行不行|明白了吗|懂了吗))(?=[。！？!?\s]*$)/gu, 2);
      value = remove(value, mapping, /(对吧|是吧)(?=[。！？!?\s]*$)/gu);
      const trim = value.match(/^[\s，,、。！？!?；;.]*/)[0].length;
      if (trim) { value = value.slice(trim); mapping.splice(0, trim); }
      value = value.replace(/[，,、\s]+([。！？!?；;.])/g, '$1').trim();
      value = value.replace(/[，,]{2,}/g, '，');
      if (!/[\p{L}\p{N}]/u.test(value)) continue;
      const key = value.toLowerCase().replace(/\s/gu, '').replace(/[.。?!？！;；]+$/gu, '')
        .replace(/[\p{P}\p{S}]/gu, (c) => /[%％+\-−<>≤≥=.]/u.test(c) ? c : '');
      const social = /^(?:嗯+|呃+|对吧|是吧|对不对|大家好|各位好|欢迎回来|谢谢大家|感谢观看|我们下期再见|大家(?:听明白了吗|明白了吗|听得到吗|能听到吗|懂了吗)|听明白了吗|明白了吗|听得到吗|能听到吗|懂了吗|helloeveryone|hieveryone)$/iu;
      if (social.test(key.replace(/\s/g, ''))) { discardedCount++; continue; }
      // A short factual answer (是/不是/不行/可以) may answer an important question.
      const duplicate = key.length >= 4 && recent.some((entry) => entry.key === key && sentence.from - entry.from <= 120);
      if (duplicate) { repeatCount++; continue; }
      recent.push({ key, from: sentence.from });
      if (recent.length > 8) recent.shift();
      const output = question ? value.replace(/[。.!！；;]+$/g, '') + (/[?？]$/.test(value) ? '' : '？') : punctuate(value);
      kept.push({ from: mapping[0]?.from ?? sentence.from, text: output });
    }
    const paragraphs = groupParagraphs(kept, opts.minChars || 180, opts.maxChars || 380).map((group) => {
      const body = group.map((s) => s.text).reduce((all, s) => all + (all && /^[A-Za-z0-9]/.test(s) ? ' ' : '') + s, '');
      return (opts.withTime ? '[' + fmt(group[0].from) + '] ' : '') + body;
    });
    const outChars = kept.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
    return { paragraphs, sentences: kept.map((s) => s.text), stats: {
      rawChars, outChars, removedChars: Math.max(0, rawChars - outChars),
      fillerChars, repeatCount, discardedCount,
      sentenceCount: kept.length, paragraphCount: paragraphs.length,
    } };
  }

  global.BiliPolish = { polish, clean, fmt, dropPhrases, dropFillerWords, dropRepeats };
})(typeof window !== 'undefined' ? window : self);

/** Format each part independently so timestamps and section boundaries survive. */
(function (global) {
  'use strict';
  function format(data, opts = {}) {
    const parts = data.parts && data.parts.length ? data.parts : [data];
    const showHeadings = data.partTotal > 1 || parts.length > 1 || parts.some((p) => p.page > 1);
    const stats = { rawChars: 0, outChars: 0, removedChars: 0, fillerChars: 0, repeatCount: 0, discardedCount: 0 };
    const body = parts.map((part) => {
      let text = part.text || '';
      if (global.BiliPolish && (opts.clean || (part.items && part.items.length))) {
        const items = part.items?.length ? part.items : [{ from: 0, to: 0,
          content: text.replace(/^\[\d+:\d+(?::\d+)?\]\s*/gm, '') }];
        const result = global.BiliPolish[opts.clean ? 'clean' : 'polish'](items, {
          withTime: opts.withTs !== false, keepFillers: true,
          termFixes: opts.termFixes,
        });
        if (opts.clean || result.paragraphs.length) text = result.paragraphs.join('\n\n');
        if (opts.clean) for (const key of Object.keys(stats)) stats[key] += result.stats[key] || 0;
      }
      return text ? (showHeadings ? `## P${part.page || 1} ${part.title || data.title}\n\n` : '') + text : '';
    }).filter(Boolean).join('\n\n');
    let head = (data.markdown || `# ${data.title}`).split('\n---\n')[0];
    if (opts.clean) {
      head = head.replace(/^# (.*)/, '# $1 —— 精简文稿');
      head += `\n\n> 本地精简：清理语气词、口头禅、重复表述和寒暄确认。减少 ${stats.removedChars} 字，合并 ${stats.repeatCount} 处重复。`;
    }
    return { ...data, text: body, markdown: head + '\n\n---\n\n' + body + '\n', ...(opts.clean ? { stats } : {}) };
  }
  global.BiliTranscript = { format };
})(typeof window !== 'undefined' ? window : self);

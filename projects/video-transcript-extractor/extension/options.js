/** options.js —— 设置页：三种保存方式 + 文件夹授权 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  transcriptSave: false, transcriptMode: 'sub', transcriptDir: '字幕',
  aiSave: false, aiMode: 'sub', aiDir: '总结',
  allParts: false, withTimestamp: true,
};

const cleanDir = (value) => BiliCore.cleanDir(value);

function setMsg(text, cls) {
  const m = $('savedMsg');
  m.textContent = text || '';
  m.style.color = cls === 'err' ? '#f53f3f' : '#00b42a';
  if (text) setTimeout(() => { if (m.textContent === text) m.textContent = ''; }, 4000);
}

/** 读取已授权目录。注意：浏览器不暴露完整路径，只拿得到文件夹名 */
async function pickedName(key) {
  try {
    const h = await window.BiliFsDir.getHandle(key);
    if (!h) return '';
    const ok = await window.BiliFsDir.ensurePermission(h, 'readwrite').catch(() => false);
    return h.name + (ok ? '' : '（需重新授权）');
  } catch (e) {
    return '';
  }
}

async function refreshPicked() {
  for (const [key, elId] of [['transcript', 'tPicked'], ['aisum', 'aPicked']]) {
    const el = $(elId);
    const name = await pickedName(key);
    if (name) {
      el.textContent = '已授权：' + name;
      el.classList.remove('empty');
    } else {
      el.textContent = '未选择（点左边按钮授权一个文件夹）';
      el.classList.add('empty');
    }
  }
}

function modeOf(name) {
  const r = document.querySelector(`input[name="${name}"]:checked`);
  return r ? r.value : 'sub';
}

function syncRows(prefix) {
  const mode = modeOf(prefix === 't' ? 'tMode' : 'aMode');
  $(prefix + 'RowDir').classList.toggle('hide', mode !== 'dir');
  $(prefix + 'RowSub').classList.toggle('hide', mode !== 'sub');
}

(async function init() {
  const cur = await chrome.storage.local.get('settings');
  const raw = cur.settings || {};
  const s = { ...DEFAULTS, ...raw };

  // 兼容旧版设置：以前只有 alwaysAsk，没有 mode
  if (!raw.transcriptMode) s.transcriptMode = raw.alwaysAsk === false ? 'sub' : 'ask';
  if (!raw.aiMode) s.aiMode = raw.alwaysAsk === false ? 'sub' : 'ask';

  $('transcriptSave').checked = !!s.transcriptSave;
  $('aiSave').checked = !!s.aiSave;
  $('transcriptDir').value = s.transcriptDir || '';
  $('aiDir').value = s.aiDir || '';
  $('allParts').checked = !!s.allParts;
  $('withTimestamp').checked = !!s.withTimestamp;
  $('termFixes').value = s.termFixes || '';

  const setRadio = (name, val) => {
    const r = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (r) r.checked = true;
  };
  setRadio('tMode', s.transcriptMode);
  setRadio('aMode', s.aiMode);
  syncRows('t');
  syncRows('a');
  const initialAi = s.ai || {};
  $('aiBaseUrl').value = initialAi.baseUrl || '';
  $('aiKey').value = initialAi.apiKey || '';
  $('aiModel').value = initialAi.model || '';
  let savedSnapshot = collect();
  let saveQueue = Promise.resolve();
  await refreshPicked();

  // 不支持 File System Access 时禁用「固定文件夹」
  if (!window.BiliFsDir.supported) {
    document.querySelectorAll('input[name="tMode"][value="dir"], input[name="aMode"][value="dir"]')
      .forEach((r) => {
        if (r.checked) {
          document.querySelector(`input[name="${r.name}"][value="ask"]`).checked = true;
        }
        r.disabled = true;
      });
    syncRows('t'); syncRows('a');
    document.querySelectorAll('#tPick, #aPick').forEach((b) => { b.disabled = true; });
    setMsg('当前浏览器不支持文件夹授权，请用「每次询问」方式', 'err');
  }

  document.querySelectorAll('input[name="tMode"], input[name="aMode"]').forEach((r) => {
    r.addEventListener('change', () => { syncRows('t'); syncRows('a'); autosave(); });
  });
  ['transcriptDir', 'aiDir'].forEach((id) => {
    $(id).addEventListener('input', () => { syncRows('t'); syncRows('a'); });
    $(id).addEventListener('change', () => autosave());   // 失焦时落盘
  });
  ['transcriptSave', 'aiSave', 'allParts', 'withTimestamp', 'termFixes'].forEach((id) => {
    $(id).addEventListener('change', () => autosave());
  });

  async function pickDir(key, prefix) {
    try {
      const h = await window.BiliFsDir.pick({ id: 'bili-' + key + '-dir', mode: 'readwrite' });
      await window.BiliFsDir.setHandle(key, h);
      const r = document.querySelector(`input[name="${prefix}Mode"][value="dir"]`);
      if (r) r.checked = true;
      await refreshPicked();
      syncRows(prefix);
      await autosave();
      setMsg('已授权文件夹：' + h.name);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // 浏览器也会在用户选了「桌面/文档/下载」这类根目录时直接拦下并弹提示，
        // 这种情况到这里就是 AbortError，和用户主动取消分不开，所以一并给出指引。
        setMsg('未授权。注意：桌面、文档、下载这些根目录浏览器不允许授权，请选它们下面的子文件夹', 'err');
        return;
      }
      setMsg('选择失败：' + ((e && e.message) || e), 'err');
    }
  }

  $('tPick').addEventListener('click', () => pickDir('transcript', 't'));
  $('aPick').addEventListener('click', () => pickDir('aisum', 'a'));

  $('tClear').addEventListener('click', async () => {
    await window.BiliFsDir.removeHandle('transcript');
    await refreshPicked();
    setMsg('已清除转录文件夹');
  });
  $('aClear').addEventListener('click', async () => {
    await window.BiliFsDir.removeHandle('aisum');
    await refreshPicked();
    setMsg('已清除总结文件夹');
  });

  // 手机端 Chromium（Edge for Android 等）没有 File System Access API，
  // 「固定文件夹」会直接报错 —— 检测到就禁用并说明，避免用户白试。
  if (!window.showDirectoryPicker) {
    ['tMode', 'aMode'].forEach((name) => {
      const r = document.querySelector(`input[name="${name}"][value="dir"]`);
      if (r) {
        r.disabled = true;
        if (r.parentElement) r.parentElement.style.opacity = '.45';
        r.title = '当前浏览器不支持目录授权（移动端没有此 API），请改用「每次询问」或「下载目录子目录」';
      }
    });
    ['tPick', 'aPick'].forEach((id) => {
      const b = $(id);
      if (b) { b.disabled = true; b.title = '当前浏览器不支持目录授权，请改用其他两种保存方式'; }
    });
  }

  $('save').addEventListener('click', () => autosave());

  // ---------- 自动保存 ----------
  // 原先只有点最底下的「保存设置」才写盘，用户改完单选一刷新就回到默认值，
  // 看起来像"选了没用"。现在任何改动立即落盘。
  function collect() {
    return {
      transcriptSave: $('transcriptSave').checked,
      transcriptMode: modeOf('tMode'),
      transcriptDir: cleanDir($('transcriptDir').value),
      aiSave: $('aiSave').checked,
      aiMode: modeOf('aMode'),
      aiDir: cleanDir($('aiDir').value),
      allParts: $('allParts').checked,
      withTimestamp: $('withTimestamp').checked,
      termFixes: $('termFixes').value,
      ai: {
        baseUrl: $('aiBaseUrl').value.trim(),
        apiKey: $('aiKey').value.trim(),
        model: $('aiModel').value.trim(),
      },
    };
  }

  function autosave() {
    const collected = collect();
    saveQueue = saveQueue.then(async () => {
      const current = (await chrome.storage.local.get('settings')).settings || {};
      const patch = {};
      for (const [key, value] of Object.entries(collected)) {
        if (JSON.stringify(value) !== JSON.stringify(savedSnapshot[key])) {
          if (key === 'ai') {
            patch.ai = { ...(current.ai || {}) };
            for (const [field, content] of Object.entries(value)) {
              if (content !== savedSnapshot.ai[field]) patch.ai[field] = content;
            }
          } else patch[key] = value;
        }
      }
      await chrome.storage.local.set({ settings: { ...DEFAULTS, ...current, ...patch } });
      savedSnapshot = collected;
      syncRows('t'); syncRows('a');
      setMsg('已保存 ✓');
      return true;
    }).catch((e) => { setMsg('保存失败：' + (e.message || e), 'err'); return false; });
    return saveQueue;
  }

  // ---------- AI 总结配置 ----------
  const ai = s.ai || {};
  $('aiBaseUrl').value = ai.baseUrl || '';
  $('aiKey').value = ai.apiKey || '';
  $('aiModel').value = ai.model || '';

  ['aiBaseUrl', 'aiKey', 'aiModel'].forEach((id) => {
    $(id).addEventListener('change', () => autosave());
  });

  const aiMsg = (text, err) => {
    const m = $('aiTestMsg');
    m.textContent = text || '';
    m.style.color = err ? '#f53f3f' : '#00b42a';
  };

  /** 自定义接口域名需要动态申请权限（manifest 里只预置了常见几家） */
  async function ensureHost(baseUrl) {
    if (!chrome.permissions || !chrome.permissions.request) return true;
    let origin;
    try {
      window.BiliAiSum.endpoint(baseUrl);
      origin = new URL(baseUrl).origin + '/*';
    } catch (e) {
      throw new Error('接口地址无效，请填写 HTTPS 地址');
    }
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      return await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      return false;
    }
  }

  $('aiTest').addEventListener('click', async () => {
    const cfg = {
      baseUrl: $('aiBaseUrl').value.trim(),
      apiKey: $('aiKey').value.trim(),
      model: $('aiModel').value.trim(),
    };
    if (!cfg.baseUrl || !cfg.model) {
      aiMsg('先填接口地址和模型名', true);
      return;
    }
    $('aiTest').disabled = true;
    aiMsg('测试中…');
    try {
      if (!(await ensureHost(cfg.baseUrl))) {
        aiMsg('没拿到该域名的访问权限，无法调用', true);
        return;
      }
      if (!(await autosave())) return;
      const r = await window.BiliAiSum.testConnection(cfg);
      aiMsg('连接正常，模型回复：' + String(r).slice(0, 30));
    } catch (e) {
      aiMsg('失败：' + ((e && e.message) || e), true);
    } finally { $('aiTest').disabled = false; }
  });
})().catch((e) => setMsg('设置加载失败：' + (e.message || e), 'err'));

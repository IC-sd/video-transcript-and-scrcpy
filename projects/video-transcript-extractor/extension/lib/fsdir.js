/**
 * fsdir.js —— 让用户指定**任意文件夹**（含 D:\ 这种绝对路径）并直接写入。
 *
 * 为什么需要它：`chrome.downloads` 只能写「浏览器下载目录 + 相对子路径」，
 * 写不了 D:\我的文档 这类绝对路径，这是浏览器的硬限制。
 * 唯一能突破的途径是 File System Access API：
 *   1. 用户点一次「选择文件夹」，授权某个目录（浏览器弹的是系统目录选择器，能看到并选任意盘任意目录）
 *   2. 目录句柄（FileSystemDirectoryHandle）存进 IndexedDB，可跨会话复用
 *   3. 之后写文件直接落进该目录，不再弹任何下载对话框
 *
 * 注意：浏览器出于隐私不暴露目录的完整路径，只能拿到目录名（handle.name）。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'bili-transcript';
  const STORE = 'dirs';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function withStore(mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const getHandle = (key) => openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const r = t.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  }));

  const setHandle = (key, handle) => withStore('readwrite', (s) => s.put(handle, key));
  const removeHandle = (key) => withStore('readwrite', (s) => s.delete(key));

  /** 权限可能在新会话里被回收，保存时要重新确认（需要用户手势） */
  async function ensurePermission(handle, mode) {
    mode = mode || 'readwrite';
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    try {
      if (await handle.queryPermission({ mode }) === 'granted') return true;
      return (await handle.requestPermission({ mode })) === 'granted';
    } catch (e) {
      return false;
    }
  }

  /** 真正支持性检测：showDirectoryPicker 在扩展页面可能被禁用 */
  const supported = (function () {
    try {
      return typeof global.showDirectoryPicker === 'function';
    } catch (e) {
      return false;
    }
  })();

  function pick(opts) {
    if (!supported) throw new Error('当前浏览器不支持文件夹选择（需要 Chrome/Edge 86+）');
    return global.showDirectoryPicker(opts || { mode: 'readwrite' });
  }

  /** relPath 支持多级，如 "字幕/2026/标题.md"；中间目录会自动创建 */
  async function writeFile(rootHandle, relPath, content) {
    const parts = String(relPath).split('/').filter(Boolean);
    const name = parts.pop();
    let dir = rootHandle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    await w.close();
    return parts.concat(name).join('/');
  }

  global.BiliFsDir = {
    supported, pick, getHandle, setHandle, removeHandle, ensurePermission, writeFile,
  };
})(window);

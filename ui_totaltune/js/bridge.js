/* ============================================================
 * TotalTune — bridge.js
 * WebView ↔ JUCE 原生桥。
 *
 * 有 window.__JUCE__（插件环境）时：
 *   - 播放/暂停 → ttPlay 事件（引擎在音频线程跑，BPM 跟宿主）
 *   - loop 选区 → ttLoop 事件
 *   - 工程变化 → ttSetProject（防抖推送整包 JSON）
 *   - temp 写盘 → ttWriteFile（原生写 %TEMP%\TotalTune\temp/）
 *   - 拖出文件 → ttDragFile（JUCE 原生系统拖拽）
 *   - 合成器面板 → ttSynth
 *   - 接收 ttState（播放头/bpm/复音警告）
 *
 * 无 __JUCE__（浏览器直接打开 index.html 调 UI）时全部退化为原型行为。
 * ============================================================ */
"use strict";

const Bridge = (() => {

  const backend = () => (window.__JUCE__ && window.__JUCE__.backend) || null;
  const hasHost = () => !!backend();

  /* ---------- 宿主 → 页面：ttState / ttRestoreState ---------- */
  const stateListeners = [];
  const restoreListeners = [];
  function onState(fn) { stateListeners.push(fn); }
  function onRestore(fn) { restoreListeners.push(fn); }

  function init() {
    const b = backend();
    if (!b) return;

    b.addEventListener("ttState", (s) => {
      for (const fn of stateListeners) fn(s);
    });
    b.addEventListener("ttRestoreState", (s) => {
      for (const fn of restoreListeners) fn(s);
    });
  }

  /* ---------- 页面 → 宿主 ---------- */
  function sendPlay(play) {
    const b = backend();
    if (b) b.emitEvent("ttPlay", { play: !!play });
  }

  function sendLoop(loop) {
    const b = backend();
    if (b) b.emitEvent("ttLoop", {
      has: !!loop,
      start: loop ? loop.start : 0,
      end: loop ? loop.end : 0,
    });
  }

  let projectTimer = 0;
  function sendProject(projectJson) {
    const b = backend();
    if (!b) return;
    clearTimeout(projectTimer);
    projectTimer = setTimeout(() => {
      b.emitEvent("ttSetProject", { json: projectJson });
    }, 30);   // 120ms → 30ms：编辑→发声延迟明显降低，仍能合并高频拖动
  }

  function sendSynth(vol, wave) {
    const b = backend();
    if (b) b.emitEvent("ttSynth", { vol, wave });
  }

  function sendSeek(beat) {
    const b = backend();
    if (b) b.emitEvent("ttSeek", { beat });
  }

  function sendSaveState(projectJson) {
    const b = backend();
    if (b) b.emitEvent("ttSaveState", { json: projectJson });
  }

  function requestState() {
    const b = backend();
    if (b) b.emitEvent("ttRequestState", {});
  }

  function sendUndo() {
    const b = backend();
    if (b) b.emitEvent("ttUndo", {});
  }

  function sendRedo() {
    const b = backend();
    if (b) b.emitEvent("ttRedo", {});
  }

  function writeFile(relPath, arrayBuffer) {
    const b = backend();
    if (!b) return Promise.resolve(false);
    const bytes = new Uint8Array(arrayBuffer);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    const b64 = btoa(bin);
    b.emitEvent("ttWriteFile", { path: relPath, dataBase64: b64 });
    return Promise.resolve(true);
  }

  function dragFile(fileName, arrayBuffer) {
    const b = backend();
    if (!b) return;
    const bytes = new Uint8Array(arrayBuffer);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    const b64 = btoa(bin);
    b.emitEvent("ttDragFile", { name: fileName, dataBase64: b64 });
  }

  return {
    hasHost, init, onState, onRestore,
    sendPlay, sendLoop, sendProject, sendSynth, sendSeek, sendSaveState, requestState,
    sendUndo, sendRedo,
    writeFile, dragFile,
  };
})();

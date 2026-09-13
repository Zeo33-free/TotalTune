/* ============================================================
 * TotalTune — live_export.js
 * 实时 MPE MIDI 输出：
 *  - 插件环境：原生写 %TEMP%\TotalTune\temp/<Scene>/<文件>.mid（无需授权）
 *  - 浏览器原型：File System Access API（需用户授权）
 *  - 左栏文件项可拖出 = 拖出对应 MPE MIDI 文件（插件环境走原生拖拽）
 * ============================================================ */
"use strict";

const LiveExport = (() => {

  let dirHandle = null;   // 浏览器原型：用户选择的输出根目录
  let timer = 0;
  let pendingProject = null;

  function available() {
    return Bridge.hasHost() || typeof window.showDirectoryPicker === "function";
  }

  /** 选择 temp 文件夹（一次性授权） */
  async function connect() {
    if (!available()) {
      App.toast("此浏览器不支持文件夹写入，请用 Chrome/Edge");
      return false;
    }
    try {
      dirHandle = await window.showDirectoryPicker({
        mode: "readwrite",
        id: "goodjust-temp",
        startIn: "desktop",
      });
      App.toast("已连接输出文件夹，编辑将实时写入");
      return true;
    } catch (e) {
      return false; // 用户取消
    }
  }

  function isConnected() { return !!dirHandle; }

  /** Windows 文件名非法字符清理（scene 目录名仍可自定义，只清非法字符） */
  function safeName(s) {
    return String(s || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
  }

  /** mid 文件名：固定 ASCII（bassN / chordN / mdN），用户要求 */
  function midName(file) {
    return Model.asciiFileName(file) + ".mid";
  }

  /** 全量写出：temp/<Scene>/<文件>.mid */
  async function writeAll(project) {
    if (Bridge.hasHost()) {
      // 插件环境：原生写盘（%TEMP%\TotalTune\temp/）
      for (const scene of project.scenes) {
        for (const f of Model.sceneFiles(scene)) {
          if (!f.notes.length) continue;
          const buf = MPEExport.exportFile(project, scene, f);
          await Bridge.writeFile(safeName(scene.name) + "/" + midName(f), buf);
        }
      }
      return;
    }
    if (!dirHandle) return;
    try {
      for (const scene of project.scenes) {
        const sDir = await dirHandle.getDirectoryHandle(safeName(scene.name), { create: true });
        for (const f of Model.sceneFiles(scene)) {
          if (!f.notes.length) continue;
          const buf = MPEExport.exportFile(project, scene, f);
          const fh = await sDir.getFileHandle(midName(f), { create: true });
          const w = await fh.createWritable();
          await w.write(buf);
          await w.close();
        }
      }
    } catch (err) {
      console.error("LiveExport.writeAll", err);
    }
  }

  /** 编辑后防抖同步（600ms 内连续编辑只写一次） */
  function scheduleSync(project, delay = 600) {
    pendingProject = project;
    if (Bridge.hasHost()) {
      clearTimeout(timer);
      timer = setTimeout(() => writeAll(pendingProject), delay);
      return;
    }
    if (!dirHandle) return;
    clearTimeout(timer);
    timer = setTimeout(() => writeAll(pendingProject), delay);
  }

  /** 左栏文件拖出 = 拖出对应 MPE MIDI 文件 */
  function dragFile(e, project, scene, file) {
    const buf = MPEExport.exportFile(project, scene, file);
    const fname = midName(file);   // ★ 固定 ASCII 名（bassN/chordN/mdN）
    if (Bridge.hasHost()) {
      // 插件环境：JUCE 原生系统拖拽（拖到宿主/资源管理器）
      Bridge.dragFile(fname, buf);
      return;
    }
    const url = URL.createObjectURL(new Blob([buf], { type: "audio/midi" }));
    const f = new File([buf], fname, { type: "audio/midi" });
    e.dataTransfer.items.add(f);
    e.dataTransfer.setData("DownloadURL", `audio/midi:${fname}:${url}`);
    e.dataTransfer.effectAllowed = "copy";
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return { available, connect, isConnected, writeAll, scheduleSync, dragFile, safeName, midName };
})();

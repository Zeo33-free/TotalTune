/* ============================================================
 * GoodJust — manager.js
 * 左栏：Scene 管理器（竖排）+ 文件列表。
 * Scene 含：1 和声 + N 旋律。
 * 新建 Scene → 弹出和声编辑弹窗。
 * 文件可复制（Ctrl+拖 或按钮），旋律可添加/删除。
 * ============================================================ */
"use strict";

const Manager = (() => {

  const sceneList = document.getElementById("scene-list");
  const fileList = document.getElementById("file-list");

  let project = null;
  let state = null;   // { sceneId, fileId }
  let onChange = null;

  /* ---------- 渲染 ---------- */
  function render() {
    renderScenes();
    renderFiles();
  }

  function renderScenes() {
    sceneList.innerHTML = "";
    for (const s of project.scenes) {
      const div = document.createElement("div");
      div.className = "scene-item";
      div.dataset.selected = String(s.id === state.sceneId);
      div.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:0.8rem;height:0.8rem;fill:var(--color-text-tertiary)">
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
        </svg>
        <span class="scene-name">${escapeHtml(s.name)}</span>
        <button class="icon-btn scene-copy" title="复制 Scene">
          <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2z"/></svg>
        </button>
        <button class="icon-btn scene-del" title="删除 Scene">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>`;
      const nameSpan = div.querySelector(".scene-name");
      nameSpan.title = "双击重命名";
      div.addEventListener("click", (e) => {
        if (e.target.closest(".scene-del")) {
          if (project.scenes.length > 1) {
            project.scenes = project.scenes.filter(x => x.id !== s.id);
            if (state.sceneId === s.id) {
              const next = project.scenes[0];
              state.sceneId = next.id;
              state.fileId = next.harmony.id;
              Editor.setScene(next);
              Editor.setActiveFile(next.harmony);
            }
            render();
            onChange();
          } else {
            App.toast("至少保留一个 Scene");
          }
          return;
        }
        if (e.target.closest(".scene-copy")) {
          const c = Model.cloneScene(s, s.name + " 副本");
          project.scenes.splice(project.scenes.indexOf(s) + 1, 0, c);
          selectScene(c.id);
          App.toast(`已复制「${s.name}」`);
          return;
        }
        // 双击重命名：DOM 会被 render() 重建，原生 dblclick 不可靠，手动计时检测
        if (isDoubleClick("scene:" + s.id)) {
          startInlineEdit(div.querySelector(".scene-name"), s.name, (v) => {
            if (v) { s.name = v; onChange(); }
            render();
          });
          return;
        }
        selectScene(s.id);
      });
      sceneList.appendChild(div);
    }
  }

  function renderFiles() {
    fileList.innerHTML = "";
    const s = project.scenes.find(x => x.id === state.sceneId);
    if (!s) return;

    const mk = (file, tag, readonly, onDelete, onCopy, onContext) => {
      const div = document.createElement("div");
      div.className = "file-item";
      div.dataset.selected = String(file.id === state.fileId);
      div.dataset.readonly = String(readonly);
      // 拖出 = 拖出对应 MPE MIDI 文件。
      // ★ 插件模式不用 HTML5 dragstart：WebView2 里原生拖拽会吞掉后续 dragstart
      //   （只能拖一次的根因）。改用 pointer 手势（按住移动 8px）主动触发。
      if (!Bridge.hasHost()) {
        div.draggable = true;
        div.addEventListener("dragstart", (e) => {
          LiveExport.dragFile(e, project, s, file);
        });
      } else {
        attachPointerDrag(div, () => LiveExport.dragFile(null, project, s, file));
      }
      const soloed = !!state.solo[file.id];
      const muted = !!state.mute[file.id];
      const color = fileColor(file);
      const knobVal = Math.round(Math.max(0, Math.min(1, typeof file.synthVol === "number" ? file.synthVol : 0.8)) * 100);
      div.innerHTML = `
        <span class="file-dot" style="background:${color}"></span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-tag">${tag}</span>
        <div class="file-knob" title="混音音量（拖动调节，双击复位）" data-val="${knobVal}">
          <div class="file-knob-ind"></div>
        </div>
        <button class="icon-btn file-solo${soloed ? " on" : ""}" title="Solo 单独播放此文件">S</button>
        <button class="icon-btn file-mute${muted ? " on" : ""}" title="Mute 静音此文件">M</button>
        ${onCopy ? `<button class="icon-btn file-copy" title="复制文件">
          <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2z"/></svg>
        </button>` : ""}
        ${onDelete ? `<button class="icon-btn file-del" title="删除文件">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>` : ""}`;
      div.querySelector(".file-solo").addEventListener("click", (e) => {
        e.stopPropagation();
        App.handleSolo(file);
      });
      div.querySelector(".file-mute").addEventListener("click", (e) => {
        e.stopPropagation();
        App.handleMute(file);
      });
      // 混音旋钮：上下拖动调节（只影响小合成器试听音量，不影响 MIDI 力度）
      attachKnobDrag(div.querySelector(".file-knob"), file);
      if (!readonly) {
        div.querySelector(".file-name").title = "双击重命名";
      }
      div.addEventListener("click", (e) => {
        if (e.target.closest(".file-copy")) { onCopy(); return; }
        if (e.target.closest(".file-del")) { onDelete(); return; }
        if (e.target.closest(".file-solo") || e.target.closest(".file-mute")) return;
        if (!readonly && isDoubleClick("file:" + file.id)) {
          startInlineEdit(div.querySelector(".file-name"), file.name, (v) => {
            if (v) { file.name = v; onChange(); }
            render();
          });
          return;
        }
        selectFile(file.id);
      });
      // 右键：代码方式编辑（和声用，同新建 Scene 的弹窗）
      if (onContext) {
        div.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          onContext();
        });
      }
      fileList.appendChild(div);
    };

    // 和声（右键 = 代码编辑和声）
    mk(s.harmony, "和声", false,
      () => App.toast("和声文件不可删除"),
      () => copyFile(s, s.harmony),
      () => { selectFile(s.harmony.id); App.openHarmonyModal(s, false); });
    // 旋律（右键 = 代码编辑旋律）
    for (const m of s.melodies) {
      mk(m, "旋律", false,
        () => {
          Model.removeMelody(s, m.id);
          if (state.fileId === m.id) {
            // ★ 同步 Editor 的 activeFile：只改 state.fileId 不调
            //   setActiveFile 的话，Editor 内部还指着已删除的旋律对象，
            //   画布上所有文件都变灰（activeFile === m 永不匹配）且无法编辑
            state.fileId = s.harmony.id;
            Editor.setActiveFile(s.harmony);
          }
          onChange();
          render();
        },
        () => copyFile(s, m),
        () => { selectFile(m.id); App.openMelodyModal(m); });
    }
  }

  function fileColor(file) {
    if (file.type === "harmony") return "var(--color-harmony)";
    const i = project.scenes.find(x => x.id === state.sceneId)
      .melodies.indexOf(file);
    return ["var(--color-melody)", "var(--color-melody-2)",
            "var(--color-melody-3)", "var(--color-melody-4)"][i % 4];
  }

  function copyFile(scene, file) {
    const c = Model.cloneFile(file, file.name + " 副本");
    if (file.type === "melody") {
      scene.melodies.push(c);
    } else {
      // 和声副本 → 作为旋律文件加入（和声每 Scene 唯一）
      c.type = "melody";
      c.name = file.name + " (副本)";
      scene.melodies.push(c);
    }
    state.fileId = c.id;
    onChange();
    render();
    App.toast(`已复制「${file.name}」`);
  }

  /* ---------- 混音旋钮 ----------
   * 上下拖动调节（上增下减），双击复位 80%。只影响内置小合成器的
   * 发声音量（本地试听/混音），不碰 MIDI 输出的力度。 */
  function attachKnobDrag(knob, file) {
    const setVal = (v) => {
      v = Math.max(0, Math.min(1, v));
      file.synthVol = v;
      knob.dataset.val = String(Math.round(v * 100));
      knob.style.setProperty("--kv", String(v));
      onChange();
    };
    knob.style.setProperty("--kv", String(Math.max(0, Math.min(1, typeof file.synthVol === "number" ? file.synthVol : 0.8))));
    knob.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const startY = e.clientY;
      const startV = typeof file.synthVol === "number" ? file.synthVol : 0.8;
      const move = (ev) => {
        setVal(startV + (startY - ev.clientY) / 150);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    knob.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      setVal(0.8);
    });
    // ★ click 也拦住：双击重命名走 div 上的 click 计时检测，
    //   旋钮的 click 冒泡上去会被误判成「双击文件项」弹出重命名
    knob.addEventListener("click", (e) => e.stopPropagation());
  }

  /* ---------- 选择 ---------- */
  function selectScene(id) {
    if (state.sceneId === id) return; // 重复点击已选中项：不重建，避免吞掉双击
    state.sceneId = id;
    const s = project.scenes.find(x => x.id === id);
    if (!s) return; // Scene 已被删除（如删除后回退选中）
    state.fileId = s.harmony.id;
    Editor.setScene(s);
    Editor.setActiveFile(s.harmony);
    render();
    onChange();
  }

  function selectFile(id) {
    if (state.fileId === id) return; // 重复点击已选中项：不重建，避免吞掉双击
    state.fileId = id;
    const s = project.scenes.find(x => x.id === state.sceneId);
    const f = Model.findFile(s, id);
    Editor.setActiveFile(f);
    render();
    onChange();
  }

  /* ---------- 新建 Scene（和声弹窗） ---------- */
  function newScene() {
    const s = Model.makeScene(`Scene ${project.scenes.length + 1}`);
    project.scenes.push(s);
    selectScene(s.id);
    App.openHarmonyModal(s, true);
  }

  /* ---------- 双击检测 ----------
   * 单击会触发 render() 重建 DOM，浏览器原生 dblclick 因两次点击
   * 落在不同元素上而永不触发。改用模块级计时检测，key 用稳定 id，
   * 跨 DOM 重建依然有效。 */
  let lastClick = { key: "", t: 0 };
  function isDoubleClick(key) {
    const now = performance.now();
    const hit = lastClick.key === key && (now - lastClick.t) < 500;
    lastClick = { key: hit ? "" : key, t: now };
    return hit;
  }

  /* ---------- 行内重命名 ---------- */
  function startInlineEdit(span, current, onCommit) {
    if (document.querySelector(".inline-rename")) return; // 已有编辑进行中
    const input = document.createElement("input");
    input.className = "inline-rename";
    input.value = current;
    input.maxLength = 48;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      onCommit(commit && v && v !== current ? v : null);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  /* ---------- utils ---------- */
  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function init(p, st, opts) {
    project = p; state = st; onChange = opts.onChange;
    document.getElementById("btn-add-scene").addEventListener("click", newScene);
    document.getElementById("btn-add-melody").addEventListener("click", () => {
      const s = project.scenes.find(x => x.id === state.sceneId);
      if (!s) return;
      const f = Model.addMelody(s);
      state.fileId = f.id;
      Editor.setActiveFile(f);
      render();
      onChange();
    });
    render();
  }

  function refresh() { render(); }

  /** project 对象被整体替换（撤销/恢复/加载）后更新引用 */
  function setProject(p) { project = p; render(); }

  /* ---------- 插件模式拖出手势 ----------
   * 按住文件项移动超过阈值 → 触发一次原生拖拽，松开/取消后可再次触发。
   * 不依赖 HTML5 dragstart（WebView2 里被原生拖拽吞掉后续事件）。 */
  function attachPointerDrag(el, onDrag) {
    let active = false, dragging = false, sx = 0, sy = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;   // S/M/复制/删除按钮不触发
      active = true; dragging = false; sx = e.clientX; sy = e.clientY;
    });
    el.addEventListener("pointermove", (e) => {
      if (!active || dragging) return;
      if (Math.abs(e.clientX - sx) < 8 && Math.abs(e.clientY - sy) < 8) return;
      dragging = true;
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      onDrag();
    });
    const end = () => { active = false; dragging = false; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  return { init, render, refresh, setProject, selectScene, selectFile, newScene };
})();

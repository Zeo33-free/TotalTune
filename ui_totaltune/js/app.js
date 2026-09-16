/* ============================================================
 * TotalTune — app.js
 * 装配：顶栏（播放/停止/BPM/量化/律制/输出/保存/加载）、
 *       和声编辑弹窗、检查器、律制面板、播放联动。
 * 插件环境（Bridge.hasHost()）：播放由原生引擎接管，BPM 跟随宿主。
 * ============================================================ */
"use strict";

const App = (() => {

  const state = {
    sceneId: null,
    fileId: null,
    solo: {},       // { 文件id: true }，solo 激活的文件类型
    mute: {},       // { 文件id: true }，静音的文件类型
  };
  let project = null;
  let playRAF = 0;
  let followPlay = true;   // 播放时是否跟随播放头滚动
  let hostPlaying = false; // 原生引擎播放中（ttState 推送）

  /* ---------- 撤销 / 重做（栈在 processor 里，前端只发命令） ---------- */
  let restoring = false;     // 恢复快照/宿主状态时不入栈

  function applyRestored(json) {
    restoring = true;
    try {
      project = Serialize.load(json);
      applyProjectToUI();
      pushProjectToHost();
      LiveExport.scheduleSync(project);
    } finally { restoring = false; }
  }

  function undo() {
    if (!Bridge.hasHost()) { toast("没有可撤销的操作"); return; }
    Bridge.sendUndo();
  }
  function redo() {
    if (!Bridge.hasHost()) { toast("没有可重做的操作"); return; }
    Bridge.sendRedo();
  }
  function doUndo() { undo(); }
  function doRedo() { redo(); }

  function isSoloed() {   // 当前 scene 是否有任何文件被 solo
    const s = currentScene();
    if (!s) return false;
    return Model.sceneFiles(s).some(f => state.solo[f.id]);
  }
  function fileAudible(file) {   // 是否发声：有 solo 时仅 solo 的文件；否则非 mute
    if (isSoloed()) return !!state.solo[file.id];
    return !state.mute[file.id];
  }

  /* ---------- solo / mute 切换 ---------- */
  function handleSolo(file) {
    const on = !state.solo[file.id];
    state.solo[file.id] = on;
    Manager.refresh();
    renderInspector();
    AudioEngine.restartIfPlaying(collectEvents());
    commitEdit();   // audible 变化影响引擎事件表
  }
  function handleMute(file) {
    const on = !state.mute[file.id];
    state.mute[file.id] = on;
    Manager.refresh();
    renderInspector();
    AudioEngine.restartIfPlaying(collectEvents());
    commitEdit();
  }

  /* ---------- 跟随播放头 ---------- */
  function toggleFollow() {
    followPlay = !followPlay;
    const b = document.getElementById("btn-follow");
    if (b) b.classList.toggle("active", followPlay);
  }

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  /* ---------- 播放 ---------- */
  function collectEvents() {
    const s = currentScene();
    if (!s) return [];
    const evs = [];
    const push = (file, kind) => {
      if (!fileAudible(file)) return;
      const fv = Math.max(0, Math.min(1, typeof file.synthVol === "number" ? file.synthVol : 0.8));
      for (const n of file.notes) {
        evs.push({ timeBeat: n.start, durBeat: n.dur, cents: n.cents, vel: n.vel, kind, fileVol: fv, _scheduled: false });
      }
    };
    push(s.harmony, "harmony");
    s.melodies.forEach(m => push(m, "melody"));
    return evs;
  }

  function togglePlay() {
    if (Bridge.hasHost()) {
      // 插件环境：播放/暂停交给原生引擎（BPM 跟宿主，暂停时原生发全音符 note off）
      const want = !hostPlaying;
      if (want) {
        // 播放前：从编辑光标（REAPER 式，常驻不动）位置起播
        Bridge.sendSeek(Editor.getEditCursor());
        pushProjectToHost();   // 确保引擎拿到最新音符
      }
      Bridge.sendPlay(want);
      hostPlaying = want;
      updatePlayButtons();
      return;
    }
    // 浏览器原型：Web Audio（★ 与插件模式一致：从编辑光标起播）
    if (AudioEngine.isPlaying()) {
      AudioEngine.stop();
      updatePlayButtons();
    } else {
      const loop = Editor.getLoop();
      const from = loop && Editor.getEditCursor() >= loop.start && Editor.getEditCursor() < loop.end
        ? loop.start : Editor.getEditCursor();
      AudioEngine.play(from);
      updatePlayButtons();
      playLoop();
    }
  }

  function updatePlayButtons() {
    const playing = Bridge.hasHost() ? hostPlaying : AudioEngine.isPlaying();
    document.getElementById("btn-play").style.display = playing ? "none" : "flex";
    document.getElementById("btn-stop").style.display = playing ? "flex" : "none";
  }

  /* ---------- 宿主状态推送（ttState）---------- */
  function handleHostState(s) {
    if (!s) return;
    const wasPlaying = hostPlaying;
    hostPlaying = !!s.playing;
    if (wasPlaying !== hostPlaying) updatePlayButtons();

    // BPM 只读显示（跟随宿主）
    if (s.bpm && Math.abs((parseFloat(document.getElementById("bpm-input").value) || 0) - s.bpm) > 0.01)
      document.getElementById("bpm-input").value = Math.round(s.bpm * 10) / 10;
    // 复音超限警告
    const warn = document.getElementById("poly-warn");
    if (warn) warn.style.display = s.polyStolen ? "block" : "none";

    // 播放头（原生引擎驱动，游动竖线；编辑光标不动）
    if (hostPlaying && typeof s.playhead === "number") {
      if (followPlay) Editor.followPlayhead(s.playhead);
      else Editor.setPlayhead(s.playhead);
    } else if (!hostPlaying && wasPlaying) {
      // 刚停止：播放头回到编辑光标处（REAPER 式）
      Editor.setPlayhead(Editor.getEditCursor());
      updatePlayButtons();
    }
  }

  /* ---------- 恢复持久化状态（编辑器打开时，宿主应答 ttRequestState） ---------- */
  let restored = false;
  function handleRestoreState(s) {
    restored = true;   // 收到应答（含空 = 新实例）→ 停止轮询
    if (!s || !s.json) return;
    try {
      applyRestored(s.json);
    } catch (err) {
      console.error("restore failed", err);
    }
  }

  function playLoop() {
    if (!AudioEngine.isPlaying()) { playRAF = 0; return; }
    if (followPlay) Editor.followPlayhead(AudioEngine.currentBeat());
    else Editor.setPlayhead(AudioEngine.currentBeat());
    // 页面失焦时 rAF 被暂停，播放头会卡住 → 定时器兜底
    playRAF = requestAnimationFrame(playLoop);
    setTimeout(() => { if (playRAF && AudioEngine.isPlaying()) playLoop(); }, 100);
  }

  /* ---------- 当前对象 ---------- */
  function currentScene() {
    return project.scenes.find(s => s.id === state.sceneId) || null;
  }
  function currentFile() {
    const s = currentScene();
    return s ? Model.findFile(s, state.fileId) : null;
  }

  /* ---------- 检查器 ---------- */
  function renderInspector() {
    const body = document.getElementById("inspector-body");
    const sel = Editor.getSelected();
    const f = currentFile();
    if (!f) { body.innerHTML = `<div class="insp-hint">未选择文件</div>`; return; }

    if (sel.length === 0) {
      body.innerHTML = `<div class="insp-hint">
        编辑「${escapeHtml(f.name)}」— ${f.notes.length} 个音符。
        双击新建音符，右键删除。
      </div>`;
      return;
    }
    const n = sel[0];
    const freq = Tuning.centsToFreq(n.cents, Tuning.getA4());
    const midiFloat = Tuning.centsToMidiFloat(n.cents, Tuning.getA4());
    const nearest = Math.round(midiFloat);
    const ratio = Tuning.getTuning().name.startsWith("JI")
      ? Tuning.snap(n.cents) : null;

    body.innerHTML = `
      <div class="insp-row">
        <span class="insp-field"><label>频率</label>
          <input id="insp-freq" type="number" step="0.01" value="${freq.toFixed(2)}"> Hz</span>
        <span class="insp-field"><label>音名</label>
          <input value="${Tuning.midiName(nearest)} ${Tuning.fmtOffset(n.cents)}" readonly></span>
        <span class="insp-field"><label>开始</label>
          <input id="insp-start" type="number" step="0.25" value="${n.start.toFixed(3)}"> 拍</span>
        <span class="insp-field"><label>时值</label>
          <input id="insp-dur" type="number" step="0.25" value="${n.dur.toFixed(3)}"> 拍</span>
        <span class="insp-field"><label>力度</label>
          <input id="insp-vel" type="number" min="1" max="127" value="${n.vel}"></span>
        ${ratio && ratio.ratio ? `<span class="insp-field"><label>比率</label>
          <input value="${ratio.ratio[0]}/${ratio.ratio[1]}" readonly></span>` : ""}
      </div>
      ${sel.length > 1 ? `<div class="insp-hint">已选中 ${sel.length} 个音符（显示第一个）</div>` : ""}
    `;

    const upd = (prop, parse) => {
      const s = currentScene();
      for (const nn of sel) {
        if (prop === "freq") {
          nn.cents = Tuning.freqToCents(parse(document.getElementById("insp-freq").value), Tuning.getA4());
          nn.cents = Math.max(Tuning.midiToCents(0), Math.min(Tuning.midiToCents(127), nn.cents));
        } else nn[prop] = parse(document.getElementById("insp-" + prop).value);
      }
      Editor.requestDraw();
      renderTuningPanel();
      commitEdit();
    };
    document.getElementById("insp-freq").addEventListener("change", () => upd("freq", parseFloat));
    document.getElementById("insp-start").addEventListener("change", () => upd("start", parseFloat));
    document.getElementById("insp-dur").addEventListener("change", () => upd("dur", parseFloat));
    document.getElementById("insp-vel").addEventListener("change", () => upd("vel", parseInt));
  }

  /* ---------- 律制面板 ---------- */
  function renderTuningPanel() {
    const t = Tuning.getTuning();
    // JI/自定义：右下角显示「编辑律制」入口（点击或点右侧律制窗均可编辑）
    const box = document.getElementById("interval-box");
    const sel = Editor.getSelected();
    box.style.display = sel.length ? "flex" : "none";
  }

  /* ---------- 自定义律制弹窗 ---------- */
  function openCustomTuningModal(editCurrent) {
    const rs = Tuning.TUNINGS.custom.ratios;
    const ta = document.getElementById("custom-tuning-text");
    const isJI = Tuning.getTuning() === Tuning.TUNINGS["ji"];
    // 编辑当前律制：JI 用其比率表，自定义用已存表，否则默认模板
    const src = editCurrent && isJI ? Tuning.TUNINGS.ji.ratios : rs;
    ta.value = (editCurrent && isJI ? src.map(r => Tuning.ratioLabel(r)).join("\n")
      : rs.length ? rs.map(r => Tuning.ratioLabel(r)).join("\n")
      : Tuning.TUNINGS.ji.ratios.map(r => Tuning.ratioLabel(r)).join("\n"));
    document.getElementById("custom-tuning-modal").style.display = "flex";
    ta.focus();
  }
  function closeCustomTuningModal() {
    document.getElementById("custom-tuning-modal").style.display = "none";
  }
  function applyCustomTuning() {
    const text = document.getElementById("custom-tuning-text").value;
    const list = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const fm = t.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
      if (fm) {
        const v = parseFloat(fm[1]) / parseFloat(fm[2]);
        if (v > 0) list.push({ v, label: `${fm[1]}/${fm[2]}` });
        continue;
      }
      const v = parseFloat(t);
      if (v > 0) list.push({ v, label: t });
    }
    if (!list.length) { toast("未解析到有效比率"); return; }
    // 确保有 1/1 基准
    if (!list.some(r => Math.abs(r.v - 1) < 1e-9)) list.unshift({ v: 1, label: "1/1" });
    list.sort((a, b) => a.v - b.v);
    Tuning.setCustomRatios(list);
    // 若当前是 JI 则同步替换 JI 比率表（保持律制选择不变）；否则切到自定义
    if (Tuning.getTuning() === Tuning.TUNINGS["ji"]) {
      Tuning.TUNINGS.ji.ratios = list.map(r => {
        const fm = r.label.match(/^(\d+)\/(\d+)$/);
        return fm ? [parseInt(fm[1]), parseInt(fm[2])] : r.v;
      });
    } else {
      project.tuning = "custom";
      Tuning.setTuning("custom");
      document.getElementById("tuning-select").value = "custom";
    }
    closeCustomTuningModal();
    renderTuningPanel();
    Editor.requestDraw();
    commitEdit();
    toast(`律制已更新（${list.length} 音级/八度）`);
  }

  /* ---------- 纯律音程构建按钮 ---------- */
  // 音程集：[{label, ratio:[n,d]}]，用户可编辑；上行/下行自动成对
  let intervals = [
    { label: "8", ratio: [2, 1] },
    { label: "3", ratio: [5, 4] },
    { label: "5", ratio: [3, 2] },
    { label: "7", ratio: [7, 4] },
    { label: "11", ratio: [11, 8] },
    { label: "13", ratio: [13, 8] },
  ];

  function buildIntervalButtons() {
    const upRow = document.getElementById("interval-row-up");
    const downRow = document.getElementById("interval-row-down");
    upRow.innerHTML = "";
    downRow.innerHTML = "";

    // grid 列数随音程数变化（最后一列固定给 n/d）
    document.querySelector(".interval-rows").style.gridTemplateColumns =
      `repeat(${intervals.length}, 1fr) 2.6rem`;

    const mkBtn = (d, dir) => {
      const b = document.createElement("button");
      b.className = "interval-btn";
      b.textContent = (dir === "up" ? "↑" : "↓") + d.label;
      b.title = `${d.ratio[0]}/${d.ratio[1]}（单击=平移，Ctrl+单击=构建）`;
      b.addEventListener("click", (e) =>
        applyInterval(d.ratio, !(e.ctrlKey || e.metaKey), dir));
      return b;
    };
    for (const d of intervals) upRow.appendChild(mkBtn(d, "up"));
    for (const d of intervals) downRow.appendChild(mkBtn(d, "down"));

    // 任意比按钮：跨两行（绝对定位在下行末尾）
    const nd = document.createElement("button");
    nd.className = "interval-btn nd-btn";
    nd.textContent = "n/d";
    nd.title = "构造任意比的音程";
    nd.addEventListener("click", openRatioModal);
    downRow.appendChild(nd);
  }

  /** 任意比弹窗 */
  function openRatioModal() {
    const inp = document.getElementById("ratio-input");
    inp.value = "";
    document.getElementById("ratio-modal").style.display = "flex";
    inp.focus();
  }
  function closeRatioModal() {
    document.getElementById("ratio-modal").style.display = "none";
  }
  function applyRatio() {
    const s = document.getElementById("ratio-input").value;
    if (!s.trim()) { closeRatioModal(); return; }
    const fm = s.trim().match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    let ratio;
    if (fm) ratio = [parseFloat(fm[1]), parseFloat(fm[2])];
    else {
      const v = parseFloat(s);
      if (!(v > 0)) { toast("无效比率"); return; }
      ratio = [v, 1];
    }
    closeRatioModal();
    applyInterval(ratio, false, "up");
  }

  /** 音程集编辑弹窗 */
  function openIntervalsModal() {
    const ta = document.getElementById("intervals-text");
    ta.value = intervals.map(d => `${d.label}:${d.ratio[0]}/${d.ratio[1]}`).join("\n");
    document.getElementById("intervals-modal").style.display = "flex";
    ta.focus();
  }
  function closeIntervalsModal() {
    document.getElementById("intervals-modal").style.display = "none";
  }

  /** 关于弹窗 */
  function openAboutModal() {
    document.getElementById("about-modal").style.display = "flex";
  }
  function closeAboutModal() {
    document.getElementById("about-modal").style.display = "none";
  }
  function applyIntervals() {
    const text = document.getElementById("intervals-text").value;
    const list = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(.+?)\s*:\s*(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
      if (!m) continue;
      const n = parseFloat(m[2]), d = parseFloat(m[3]);
      if (!(n > 0 && d > 0)) continue;
      list.push({ label: m[1].trim(), ratio: [n, d] });
    }
    if (!list.length) { toast("未解析到有效音程"); return; }
    intervals = list;
    buildIntervalButtons();
    closeIntervalsModal();
    commitEdit();
    toast(`音程集已更新（${list.length} 个）`);
  }

  /**
   * 对选中音符应用纯律音程：
   *  - ctrl=false：构建新音符（同 start/dur，频率 × ratio；dir=down 时 ÷）
   *  - ctrl=true ：平移该音符
   */
  function applyInterval(ratio, translate, dir) {
    const sel = Editor.getSelected();
    if (!sel.length) { toast("先选中一个音符"); return; }
    const f = Editor.getActiveFile();
    const s = window.__debug.scene();
    const [rn, rd] = ratio;
    const centsShift = 1200 * Math.log2(rn / rd) * (dir === "down" ? -1 : 1);
    const lo = Tuning.midiToCents(0), hi = Tuning.midiToCents(127);
    if (translate) {
      for (const n of sel) n.cents = Math.max(lo, Math.min(hi, n.cents + centsShift));
      toast(`已平移 ${dir === "down" ? "↓" : "↑"}${rn}/${rd}`);
    } else {
      for (const n of sel) {
        f.notes.push(Model.makeNote(n.start, n.dur,
          Math.max(lo, Math.min(hi, n.cents + centsShift)), n.vel));
      }
      toast(`已构建 ${dir === "down" ? "↓" : "↑"}${rn}/${rd}`);
    }
    if (f.type === "harmony") renderInspector();
    Editor.requestDraw();
    commitEdit();
  }

  /** 选中状态变化时显示/隐藏音程区 */
  function updateIntervalBoxVisibility() {
    const sel = Editor.getSelected();
    document.getElementById("interval-box").style.display = sel.length ? "flex" : "none";
  }

  /* ---------- 和声弹窗 ---------- */
  let harmonyModalScene = null;
  function openHarmonyModal(scene, isNew) {
    harmonyModalScene = scene;
    document.getElementById("hm-scene-name").textContent = scene.name;
    const ta = document.getElementById("harmony-text");
    // ★ 已有和声时由当前音符反推文本（编辑器里改过音符也能同步回来），
    //   只有和声为空才回退到上次保存的 harmonyText / 默认模板
    ta.value = isNew ? "0:0,4,7,11\n5:0,3,7\n7:0,4,7,10"
             : (scene.harmony.notes.length ? Model.harmonyToText(scene)
                                           : (scene.harmonyText || "0:0,4,7,11\n5:0,3,7\n7:0,4,7,10"));
    document.getElementById("harmony-modal").style.display = "flex";
    ta.focus();
  }
  function closeHarmonyModal() {
    document.getElementById("harmony-modal").style.display = "none";
    harmonyModalScene = null;
  }
  function applyHarmony() {
    if (!harmonyModalScene) return;
    const text = document.getElementById("harmony-text").value;
    harmonyModalScene.harmonyText = text;
    harmonyModalScene.harmony.notes = Model.parseHarmonyText(text);
    closeHarmonyModal();
    Editor.requestDraw();
    renderInspector();
    commitEdit();
    toast("和声已更新");
  }

  /* ---------- 旋律弹窗（代码编辑，右键旋律文件打开） ---------- */
  let melodyModalFile = null;
  function openMelodyModal(file) {
    melodyModalFile = file;
    document.getElementById("mm-file-name").textContent = file.name;
    const ta = document.getElementById("melody-text");
    ta.value = file.notes.length ? Model.melodyToText(file)
                                 : "0:1:60\n1:1:62\n2:1:64";
    document.getElementById("melody-modal").style.display = "flex";
    ta.focus();
  }
  function closeMelodyModal() {
    document.getElementById("melody-modal").style.display = "none";
    melodyModalFile = null;
  }
  function applyMelody() {
    if (!melodyModalFile) return;
    const text = document.getElementById("melody-text").value;
    const notes = Model.parseMelodyText(text);
    if (!notes.length) { toast("未解析到有效音符"); return; }
    melodyModalFile.notes = notes;
    closeMelodyModal();
    Editor.requestDraw();
    renderInspector();
    commitEdit();
    toast("旋律已更新");
  }

  /* ---------- 保存 / 加载 ---------- */
  function saveProject() {
    const json = Serialize.save(project);
    if (Bridge.hasHost()) {
      // 插件环境：存进插件状态（随宿主工程保存）+ 用户指定位置
      Bridge.sendSaveState(json);
      saveProjectAs(json);   // ★ 用户指定位置（File System Access API）
      return;
    }
    saveProjectAs(json);
  }

  /** 保存到用户指定位置（showSaveFilePicker；不支持时退化为下载） */
  async function saveProjectAs(json) {
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: "totaltune.ttk",
          types: [{ description: "TotalTune 工程", accept: { "application/json": [".ttk"] } }],
        });
        const w = await handle.createWritable();
        await w.write(new Blob([json], { type: "application/json" }));
        await w.close();
        toast("已保存");
        return;
      }
    } catch (e) {
      return;   // 用户取消
    }
    // 退化：下载
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.getElementById("dl-anchor");
    a.href = url;
    a.download = "totaltune.ttk";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已保存 totaltune.ttk");
  }
  function loadProject(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        project = Serialize.load(reader.result);
        // ★ 清掉旧工程的 solo/mute（文件 id 已变，残留会意外静音新工程）
        state.solo = {};
        state.mute = {};
        applyProjectToUI();
        commitEdit();   // 撤销入栈 + 推引擎 + 存插件状态
        toast("工程已加载");
      } catch (err) {
        toast("加载失败：" + err.message);
      }
    };
    reader.readAsText(file);
  }

  function applyProjectToUI() {
    Tuning.setTuning(project.tuning);
    Tuning.setA4(project.a4);
    document.getElementById("bpm-input").value = project.bpm;
    document.getElementById("tuning-select").value = project.tuning;
    document.getElementById("a4-input").value = project.a4;
    document.getElementById("snap-enabled").checked = project.snapEnabled;
    document.getElementById("snap-denom").value = String(project.snapDenom);
    document.getElementById("snap-triplet").checked = project.snapTriplet;
    document.getElementById("snap-tuning").checked = !!project.snapTuning;
    Editor.setTuningSnap(!!project.snapTuning);

    // 保留当前选中（若还在）；否则回第一个 Scene
    const keepScene = project.scenes.find(s => s.id === state.sceneId);
    state.sceneId = keepScene ? keepScene.id : project.scenes[0].id;
    const s = currentScene();
    const keepFile = Model.findFile(s, state.fileId);
    state.fileId = keepFile ? keepFile.id : s.harmony.id;
    Editor.setProject(project);
    Editor.setScene(s);
    Editor.setActiveFile(Model.findFile(s, state.fileId));
    Manager.setProject(project);   // project 可能被整体替换（撤销/恢复），同步引用
    renderTuningPanel();
    renderInspector();
    Editor.requestDraw();
  }

  /* ---------- 工程数据 → 原生引擎 ---------- */
  function pushProjectToHost() {
    if (!Bridge.hasHost()) return;
    const s = currentScene();
    const payload = {
      bpm: project.bpm,
      a4: project.a4,
      activeScene: s ? s.name : "",
      scenes: project.scenes.map(sc => ({
        name: sc.name,
        files: Model.sceneFiles(sc).map(f => ({
          name: f.name,
          type: f.type,
          audible: fileAudible(f),
          synthVol: Math.max(0, Math.min(1, typeof f.synthVol === "number" ? f.synthVol : 0.8)),
          notes: f.notes.map(n => ({ start: n.start, dur: n.dur, cents: n.cents, vel: n.vel })),
        })),
      })),
    };
    Bridge.sendProject(JSON.stringify(payload));
  }

  /* ---------- 编辑提交：processor 撤销入栈 + 推引擎 + 存插件状态 + 写 temp ---------- */
  function commitEdit() {
    if (restoring) return;
    pushProjectToHost();
    if (Bridge.hasHost()) Bridge.sendSaveState(Serialize.save(project));
    LiveExport.scheduleSync(project);
  }

  /* ---------- 小合成器面板 ---------- */
  function initSynthPanel() {
    const btn = document.getElementById("btn-synth");
    const panel = document.getElementById("synth-panel");
    const close = document.getElementById("synth-close");
    const vol = document.getElementById("synth-vol");
    const volVal = document.getElementById("synth-vol-val");
    const waves = document.getElementById("synth-waves");
    if (!btn || !panel) return;

    btn.addEventListener("click", () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
    close.addEventListener("click", () => { panel.style.display = "none"; });

    vol.addEventListener("input", () => {
      volVal.textContent = vol.value;
      Bridge.sendSynth(parseInt(vol.value) / 100, currentWave());
    });
    waves.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-wave]");
      if (!b) return;
      waves.querySelectorAll("button").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      Bridge.sendSynth(parseInt(vol.value) / 100, parseInt(b.dataset.wave));
    });
  }
  function currentWave() {
    const on = document.querySelector("#synth-waves button.on");
    return on ? parseInt(on.dataset.wave) : 0;
  }

  /* ---------- 工具 ---------- */
  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------- 初始化 ---------- */
  function init() {
    project = Model.makeProject();

    AudioEngine.init({
      getEvents: collectEvents,
      getBpm: () => project.bpm,
      getLoop: () => Editor.getLoop(),
      onEnd: () => { updatePlayButtons(); Editor.setPlayhead(Editor.getLoop() ? Editor.getLoop().start : 0); },
    });

    Editor.init({
      onChange: () => {
        renderInspector(); updateIntervalBoxVisibility();
        commitEdit();   // 撤销入栈 + 推引擎 + 存插件状态 + 写 temp
      },
      onSelectionChange: () => { renderInspector(); updateIntervalBoxVisibility(); },
      onPlayheadMove: (beat) => {
        if (Bridge.hasHost()) {
          // 插件环境：拖标尺 → 原生引擎定位（修「光标手动调整不管用」）
          Bridge.sendSeek(beat);
          return;
        }
        AudioEngine.ensureCtx();
        if (AudioEngine.isPlaying()) AudioEngine.seekTo(beat);   // 播放中拖标尺即时跳转
      },
      onUndo: undo,
      onRedo: redo,
      onLightChange: () => { renderInspector(); updateIntervalBoxVisibility(); },   // 拖动中：只刷新 UI，不提交
      onTuningSnapChange: (on) => {   // W 键切换吸附律制 → 同步工程状态
        project.snapTuning = on;
        commitEdit();
      },
    });

    Manager.init(project, state, {
      onChange: () => {
        renderInspector();
        commitEdit();
      },
    });

    // 插件环境：temp 目录由原生自动创建（%TEMP%\TotalTune），无需授权
    if (Bridge.hasHost()) LiveExport.writeAll(project);

    // 顶栏
    document.getElementById("btn-play").addEventListener("click", togglePlay);
    document.getElementById("btn-stop").addEventListener("click", togglePlay);
    document.getElementById("btn-follow").addEventListener("click", toggleFollow);
    // BPM 跟随宿主：输入框只读（插件环境）
    if (Bridge.hasHost()) {
      const bpmInput = document.getElementById("bpm-input");
      bpmInput.readOnly = true;
      bpmInput.title = "BPM 跟随宿主，此处只读";
    } else {
      document.getElementById("bpm-input").addEventListener("change", (e) => {
        project.bpm = Math.max(20, Math.min(300, parseFloat(e.target.value) || 120));
      });
    }
    document.getElementById("snap-enabled").addEventListener("change", (e) => {
      project.snapEnabled = e.target.checked;
      Editor.requestDraw();
      commitEdit();
    });
    document.getElementById("snap-denom").addEventListener("change", (e) => {
      project.snapDenom = parseInt(e.target.value);
      Editor.requestDraw();
      commitEdit();
    });
    document.getElementById("snap-triplet").addEventListener("change", (e) => {
      project.snapTriplet = e.target.checked;
      Editor.requestDraw();
      commitEdit();
    });
    // 自动吸附律制：拖动中音高始终吸附当前律制音级（与 Alt 无关，不锁时间）
    document.getElementById("snap-tuning").addEventListener("change", (e) => {
      project.snapTuning = e.target.checked;
      Editor.setTuningSnap(e.target.checked);
      Editor.requestDraw();
      commitEdit();
    });
    document.getElementById("tuning-select").addEventListener("change", (e) => {
      if (e.target.value === "custom") {
        openCustomTuningModal();
        if (!Tuning.getTuning().ratios || !Tuning.getTuning().ratios.length) {
          // 尚未定义自定义律制则回退
          e.target.value = project.tuning;
        }
        return;
      }
      project.tuning = e.target.value;
      Tuning.setTuning(project.tuning);
      renderTuningPanel();
      Editor.requestDraw();
      commitEdit();
    });
    // 点击右侧律制钢琴窗 → 编辑当前律制的音级（JI/自定义）
    document.getElementById("tuningcolumn").addEventListener("dblclick", () => {
      if (Tuning.getTuning() === Tuning.TUNINGS["12tet"]) return;
      openCustomTuningModal(true);
    });
    document.getElementById("a4-input").addEventListener("change", (e) => {
      project.a4 = Math.max(380, Math.min(500, parseFloat(e.target.value) || 440));
      Tuning.setA4(project.a4);
      Editor.requestDraw();
      renderInspector();
      commitEdit();
    });
    document.getElementById("btn-save").addEventListener("click", saveProject);
    document.getElementById("btn-load").addEventListener("click", () => {
      document.getElementById("file-input").click();
    });
    // 关于弹窗
    document.getElementById("btn-about").addEventListener("click", openAboutModal);
    document.getElementById("ab-ok").addEventListener("click", closeAboutModal);
    document.getElementById("about-modal").addEventListener("click", (e) => {
      if (e.target.id === "about-modal") closeAboutModal();
    });
    // 锚点锁定：开启后选中音符不再改变律制窗 1/1 中心
    const lockBtn = document.getElementById("btn-anchor-lock");
    if (lockBtn) lockBtn.addEventListener("click", () => {
      const on = !lockBtn.classList.contains("on");
      lockBtn.classList.toggle("on", on);
      Editor.setAnchorLocked(on);
    });
    document.getElementById("file-input").addEventListener("change", (e) => {
      if (e.target.files[0]) loadProject(e.target.files[0]);
      e.target.value = "";
    });

    // 和声弹窗
    document.getElementById("hm-ok").addEventListener("click", () => {
      applyHarmony();
      LiveExport.scheduleSync(project);
    });
    document.getElementById("hm-cancel").addEventListener("click", closeHarmonyModal);
    document.getElementById("harmony-modal").addEventListener("click", (e) => {
      if (e.target.id === "harmony-modal") closeHarmonyModal();
    });

    // 旋律弹窗
    document.getElementById("mm-ok").addEventListener("click", () => {
      applyMelody();
      LiveExport.scheduleSync(project);
    });
    document.getElementById("mm-cancel").addEventListener("click", closeMelodyModal);
    document.getElementById("melody-modal").addEventListener("click", (e) => {
      if (e.target.id === "melody-modal") closeMelodyModal();
    });

    // 自定义律制弹窗
    document.getElementById("ct-ok").addEventListener("click", () => {
      applyCustomTuning();
      LiveExport.scheduleSync(project);
    });
    document.getElementById("ct-cancel").addEventListener("click", closeCustomTuningModal);
    document.getElementById("custom-tuning-modal").addEventListener("click", (e) => {
      if (e.target.id === "custom-tuning-modal") closeCustomTuningModal();
    });

    // 音程集编辑弹窗
    document.getElementById("btn-edit-intervals").addEventListener("click", openIntervalsModal);
    document.getElementById("iv-ok").addEventListener("click", applyIntervals);
    document.getElementById("iv-cancel").addEventListener("click", closeIntervalsModal);
    document.getElementById("intervals-modal").addEventListener("click", (e) => {
      if (e.target.id === "intervals-modal") closeIntervalsModal();
    });

    // 任意比弹窗
    document.getElementById("rt-ok").addEventListener("click", applyRatio);
    document.getElementById("rt-cancel").addEventListener("click", closeRatioModal);
    document.getElementById("ratio-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyRatio();
      if (e.key === "Escape") closeRatioModal();
    });
    document.getElementById("ratio-modal").addEventListener("click", (e) => {
      if (e.target.id === "ratio-modal") closeRatioModal();
    });

    // 纯律音程按钮
    buildIntervalButtons();
    updateIntervalBoxVisibility();

    // 插件桥：状态接收 + 初始工程推送 + 持久化恢复
    Bridge.init();
    Bridge.onState(handleHostState);
    Bridge.onRestore(handleRestoreState);
    initSynthPanel();

    applyProjectToUI();
    updatePlayButtons();
    pushProjectToHost();

    if (Bridge.hasHost()) {
      // ★ 向宿主要回上次保存的工程（修「打开全新」）。
      // emitEventIfBrowserIsVisible 可能因页面未可见被丢，轮询重试直到收到应答
      Bridge.requestState();
      let tries = 0;
      const poll = setInterval(() => {
        if (restored || ++tries > 20) { clearInterval(poll); return; }
        Bridge.requestState();
      }, 250);
    }

    // 撤销/重做按钮（顶栏，若存在）
    const ub = document.getElementById("btn-undo");
    const rb = document.getElementById("btn-redo");
    if (ub) ub.addEventListener("click", doUndo);
    if (rb) rb.addEventListener("click", doRedo);
  }

  // 调试句柄（原型阶段用；转 JUCE 时移除）
  window.__debug = {
    get project() { return project; },
    get state() { return state; },
    scene: () => project.scenes.find(s => s.id === state.sceneId) || null,
    file: () => Editor.getActiveFile(),
  };

  return { init, toast, togglePlay, openHarmonyModal, openMelodyModal, openCustomTuningModal,
    handleSolo, handleMute, toggleFollow, pushProjectToHost, fileAudible,
    doUndo, doRedo };
})();

window.addEventListener("DOMContentLoaded", () => App.init());

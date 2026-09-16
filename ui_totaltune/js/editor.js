/* ============================================================
 * GoodJust — editor.js
 * 主编辑器 canvas：
 *  - 横轴 = 时间（拍），纵轴 = 频率（对数 cents 轴）
 *  - 量化竖线（可开关，1/1–1/128 + triplet）
 *  - 双击新建音符；拖动移动；拖右缘改长度
 *  - Alt+拖动：音高吸附到律制音级（时值锁定）
 *  - Ctrl+滚轮：纵向缩放；Alt+滚轮：横向缩放
 *  - 和声文件未选中时变灰但仍显示，旋律音高可与其对齐
 * ============================================================ */
"use strict";

const Editor = (() => {

  const canvas = document.getElementById("editor-canvas");
  const ctx2d = canvas.getContext("2d");
  const ruler = document.getElementById("ruler");
  const rulerCtx = ruler.getContext("2d");
  const RULER_INITIALIZED = "__ruler_events_attached";

  /* ---------- 视口 ---------- */
  const view = {
    scrollBeat: 0,        // 左端拍
    pxPerBeat: 96,        // 横向缩放
    centsCenter: Tuning.midiToCents(60), // 视口中心频率（cents，初始 C4）
    centsSpan: 3600,      // 视口内 cents 跨度（纵向缩放）
  };

  const COLORS = {
    grid: "#2a2c36",
    gridStrong: "#3a3d4a",
    beat: "#34374a",
    bar: "#454a63",
    playhead: "#DE5267",
    theme: "#7A5CDD",
    harmonyDim: "rgba(222,177,38,0.28)",
    harmonySel: "#DEB126",
    melody: ["#3C57DD", "#7A5CDD", "#DD5C9E", "#2FA8C7"],
    noteBorder: "rgba(0,0,0,0.4)",
    selBorder: "#ffffff",
    alignLine: "rgba(255,255,255,0.35)",
  };

  /** 颜色变灰（非活动文件）：与背景混合 */
  function dimColor(hex) {
    const bg = [37, 38, 45]; // #25262D
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const mix = (c) => Math.round(c * 0.35 + bg[0] * 0.65 * (c / 255) + bg[0] * 0.0);
    // 简单去饱和 + 压暗
    const gray = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    const dim = (c) => Math.round(gray * 0.55 + c * 0.15);
    return `rgb(${dim(r)},${dim(g)},${dim(b)})`;
  }

  /* ---------- 状态 ---------- */
  let project = null;
  let scene = null;          // 当前 scene
  let activeFile = null;     // 当前编辑的文件
  let selected = new Set();  // 选中的 note id
  let clipboard = [];
  let playheadBeat = 0;      // 游动播放头（播放时移动的竖线）
  let editCursorBeat = 0;    // ★ 编辑光标（REAPER 式，常驻不动）：决定起播位置和粘贴位置
  let playing = false;
  let loop = null;           // {start, end} 播放选区，null=无

  let drag = null;           // {mode:'move'|'resize'|'new', ...}
  let marquee = null;        // ★ 框选（橡皮筋）：{x0,y0,x1,y1, add:Ctrl追加}
  let anchorLocked = false;  // ★ 锁定 1/1 锚点（律制窗不动）
  let tuningSnap = false;    // ★ 自动吸附律制：拖动中音高始终吸附当前律制音级（不锁时间、不吸其他音符）
  let rulerDrag = null;      // 标尺拖选 {mode:'seek'|'loop', grabBeat, anchor}
  let altAlign = null;       // Alt 对齐状态 {targetCents}
  let onChange = null;       // 数据变化回调
  let onSelectionChange = null;
  let onPlayheadMove = null;
  let onUndo = null;
  let onRedo = null;
  let onLightChange = null;
  let onTuningSnapChange = null;   // W 键切换吸附律制 → 通知 App 同步工程状态

  /* ---------- 几何 ---------- */
  function beatToX(beat) { return (beat - view.scrollBeat) * view.pxPerBeat; }
  function xToBeat(x) { return view.scrollBeat + x / view.pxPerBeat; }

  function yOfCents(cents) {
    const h = canvas.clientHeight;
    const t = (cents - (view.centsCenter - view.centsSpan / 2)) / view.centsSpan;
    return h - t * h; // 高频在上
  }
  function centsOfY(y) {
    const h = canvas.clientHeight;
    const t = 1 - y / h;
    return view.centsCenter - view.centsSpan / 2 + t * view.centsSpan;
  }

  /* ---------- 量化 ---------- */
  function gridStep() {
    const denom = project.snapDenom || 4;
    const triplet = project.snapTriplet;
    // triplet：三分之二长度（如 1/4 triplet = 2/3 拍的 1/4? 标准：triplet 网格 = (2/3)/denom*... ）
    // 约定：triplet 时 step = (2/3) * (1/denom) * 2 = 2/(3*denom) 拍
    const base = 1 / denom;
    return triplet ? base * (2 / 3) : base;
  }
  function snapTime(beat) {
    if (!project.snapEnabled) return beat;
    const step = gridStep();
    return Math.round(beat / step) * step;
  }

  /* ---------- 尺寸 ---------- */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = "#25262D";
    ctx2d.fillRect(0, 0, w, h);

    drawGrid(w, h);
    drawLoopRegion(w, h);
    KeyColumn.draw({ yOfCents });
    // 律制窗 1/1 锚点：选中音符时 = 音符音高，否则 C4。
    // 拖动中冻结锚点；锁定开关开启后完全不变。
    if (!anchorLocked && !drag) {
      const selFirst = getSelected()[0];
      Tuning.setAnchor(selFirst ? selFirst.cents : Tuning.midiToCents(60));
    }
    const anchorCents = Tuning.getAnchor();
    TuningColumn.draw({ yOfCents }, anchorCents);
    drawRuler();
    hscrollPaint();
    if (!scene) { drawPlayhead(w, h); return; }

    // 绘制顺序：和声（灰/亮）→ 旋律 → 选中文件置顶
    const harmonyActive = activeFile && activeFile.type === "harmony";

    // 和声：仅当和声是当前编辑文件时高亮，否则变灰
    drawFileNotes(scene.harmony, harmonyActive ? COLORS.harmonySel : COLORS.harmonyDim,
      harmonyActive, w, h);
    // 旋律：仅当前编辑的旋律高亮，其余变灰
    scene.melodies.forEach((m, i) => {
      const c = COLORS.melody[i % COLORS.melody.length];
      const active = activeFile === m;
      drawFileNotes(m, active ? c : dimColor(c), active, w, h);
    });

    drawMarquee(w, h);
    drawAlignIndicator(w, h);
    drawPlayhead(w, h);
  }

  function drawGrid(w, h) {
    if (!project) return;
    const step = gridStep();
    const b0 = Math.floor(xToBeat(0) / step) * step;
    const b1 = xToBeat(w);
    for (let b = b0; b <= b1; b += step) {
      const x = beatToX(b);
      const isBar = Math.abs(b - Math.round(b)) < 1e-6;
      const isBeat = Math.abs(b * (project.snapDenom || 4) - Math.round(b * (project.snapDenom || 4))) < 1e-6;
      ctx2d.fillStyle = isBar ? COLORS.bar : (isBeat ? COLORS.beat : COLORS.grid);
      ctx2d.fillRect(x, 0, 1, h);
    }
    // 横向：每 100 cents 一条淡线，每 1200 一条强线
    const c0 = centsOfY(h), c1 = centsOfY(0);
    for (let c = Math.floor(c0 / 100) * 100; c <= c1; c += 100) {
      const y = yOfCents(c);
      const isOct = ((c % 1200) + 1200) % 1200 === 0;
      ctx2d.fillStyle = isOct ? COLORS.gridStrong : COLORS.grid;
      ctx2d.fillRect(0, y, w, 1);
    }
  }

  /* ---------- 时间标尺 ---------- */
  function rulerXToBeat(x) { return view.scrollBeat + x / view.pxPerBeat; }

  /** 主画布上的 loop 选区遮罩：选区外变暗 */
  function drawLoopRegion(w, h) {
    if (!loop) return;
    const x1 = beatToX(loop.start), x2 = beatToX(loop.end);
    ctx2d.fillStyle = "rgba(0,0,0,0.35)";
    if (x1 > 0) ctx2d.fillRect(0, 0, Math.min(w, x1), h);
    if (x2 < w) ctx2d.fillRect(Math.max(0, x2), 0, w - Math.max(0, x2), h);
    // 选区边界线
    ctx2d.fillStyle = COLORS.theme;
    if (x1 >= 0 && x1 <= w) ctx2d.fillRect(x1, 0, 1.5, h);
    if (x2 >= 0 && x2 <= w) ctx2d.fillRect(x2, 0, 1.5, h);
  }

  function drawRuler() {
    if (!project) return;
    const w = ruler.clientWidth, h = ruler.clientHeight;
    const g = rulerCtx;
    const dpr = window.devicePixelRatio || 1;
    if (ruler.width !== w * dpr) { ruler.width = w * dpr; ruler.height = h * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // loop 选区高亮
    if (loop) {
      const x1 = beatToX(loop.start), x2 = beatToX(loop.end);
      if (x2 > 0 && x1 < w) {
        g.fillStyle = "rgba(122,92,221,0.28)";
        g.fillRect(Math.max(0, x1), 0, Math.min(w, x2) - Math.max(0, x1), h);
        g.fillStyle = COLORS.theme || "#4C6FFF";
        g.fillRect(x1, 0, 1.5, h);
        g.fillRect(x2, 0, 1.5, h);
      }
    }

    // 小节/拍刻度
    g.fillStyle = "#8a8fa8";
    g.font = "9px " + (getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono") || "monospace");
    g.textBaseline = "bottom";

    const b0 = Math.max(0, Math.floor(rulerXToBeat(0)));
    const b1 = rulerXToBeat(w);
    // 自适应刻度步进：保证刻度间距约 ≥60px
    const pxWanted = 64;
    let step = gridStep();
    while (step * view.pxPerBeat < pxWanted) step *= 2;

    for (let b = Math.floor(b0 / step) * step; b <= b1; b += step) {
      if (b < 0) continue;
      const x = beatToX(b);
      if (x < 0 || x > w) continue;
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x, h - (Math.abs(b % 4) < 1e-6 ? 8 : 4));
      g.strokeStyle = "#9aa0b8";
      g.stroke();
      // 每小节(tick%4==0)标数字
      if (Math.abs(b % 4) < 1e-6) {
        g.fillText(String(Math.floor(b / 4) + 1), x + 2, h - 2);
      }
    }

    // 播放头（游动竖线）+ 编辑光标（三角标记，常驻不动）
    const px = beatToX(playheadBeat);
    if (px >= -8 && px <= w + 8) {
      g.fillStyle = COLORS.playhead;
      g.fillRect(px, 0, 1.5, h);
    }
    const cx = beatToX(editCursorBeat);
    if (cx >= -8 && cx <= w + 8) {
      g.fillStyle = COLORS.playhead;
      g.beginPath();
      g.moveTo(cx - 5, 0);
      g.lineTo(cx + 6, 0);
      g.lineTo(cx + 0.75, 8);
      g.closePath();
      g.fill();
    }
  }

  /** 选区范围（App 用于限定播放） */
  function getLoop() { return loop; }
  function clearLoop() { loop = null; requestDraw(); notifyLoop(); }

  /** loop 变化 → 原生引擎 */
  function notifyLoop() {
    if (Bridge.hasHost()) Bridge.sendLoop(loop);
  }

  /* ---------- 标尺交互 ---------- */
  const EDGE_GRAB = 5; // 选区边缘抓取半径（px）
  ruler.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const r = ruler.getBoundingClientRect();
    const x = e.clientX - r.left;
    const beat = rulerXToBeat(x);
    if (e.button === 2) { loop = null; requestDraw(); notifyLoop(); return; }
    // 悬停在选区边缘 → 拖动调整该边缘
    if (loop && !e.shiftKey) {
      const ex1 = beatToX(loop.start), ex2 = beatToX(loop.end);
      if (Math.abs(x - ex1) <= EDGE_GRAB) {
        rulerDrag = { mode: "loop-start" };
        requestDraw();
        return;
      }
      if (Math.abs(x - ex2) <= EDGE_GRAB) {
        rulerDrag = { mode: "loop-end" };
        requestDraw();
        return;
      }
    }
    if (e.shiftKey) {
      // Shift+拖 = 框选 loop 选区
      const snapped = project.snapEnabled ? snapTime(beat) : beat;
      rulerDrag = { mode: "loop", anchor: snapped };
      loop = null;
    } else {
      // 单击/拖动 = 定位编辑光标（播放中即时跳转播放头，光标本身不动）
      editCursorBeat = Math.max(0, project.snapEnabled ? snapTime(beat) : beat);
      playheadBeat = editCursorBeat;
      if (onPlayheadMove) onPlayheadMove(editCursorBeat);
      rulerDrag = { mode: "seek" };
      requestDraw();
    }
  });
  ruler.addEventListener("mousemove", (e) => {
    const r = ruler.getBoundingClientRect();
    const x = e.clientX - r.left;
    const beat = rulerXToBeat(x);
    if (!rulerDrag) {
      // hover 光标：选区边缘显示左右箭头
      let cur = "default";
      if (loop) {
        const ex1 = beatToX(loop.start), ex2 = beatToX(loop.end);
        if (Math.abs(x - ex1) <= EDGE_GRAB || Math.abs(x - ex2) <= EDGE_GRAB) cur = "ew-resize";
      }
      ruler.style.cursor = cur;
      return;
    }
    const snapped = project.snapEnabled ? snapTime(beat) : beat;
    if (rulerDrag.mode === "loop") {
      const a = rulerDrag.anchor;
      loop = snapped >= a ? { start: a, end: snapped } : { start: snapped, end: a };
      if (loop.start >= loop.end) loop = null; // 起点/终点重叠 → 选区消失
    } else if (rulerDrag.mode === "loop-start" && loop) {
      const start = Math.max(0, snapped);
      loop = start < loop.end ? { start, end: loop.end } : null;
      if (!loop) rulerDrag = null; // 拖过另一端 → 选区消失，结束拖动
    } else if (rulerDrag.mode === "loop-end" && loop) {
      const end = Math.max(0, snapped);
      loop = end > loop.start ? { start: loop.start, end } : null;
      if (!loop) rulerDrag = null;
    } else {
      editCursorBeat = Math.max(0, snapped);
      playheadBeat = editCursorBeat;
      if (onPlayheadMove) onPlayheadMove(editCursorBeat);
    }
    requestDraw();
  });
  window.addEventListener("mouseup", () => {
    if (loop && loop.start >= loop.end) loop = null; // 零宽/重叠选区自动消失
    rulerDrag = null;
    requestDraw();
    notifyLoop();
  });

  function drawFileNotes(file, color, isActive, w, h) {
    if (!file) return;
    const isSelFile = file === activeFile;
    for (const n of file.notes) {
      const x = beatToX(n.start);
      const x2 = beatToX(n.start + n.dur);
      if (x2 < 0 || x > w) continue;
      const y = yOfCents(n.cents);
      const nh = Math.max(3, yOfCents(n.cents - 25) - yOfCents(n.cents + 25));   // ★ 高度减半
      const sel = selected.has(n.id) && isSelFile;

      ctx2d.fillStyle = color;
      ctx2d.globalAlpha = isActive ? 1 : (file.type === "harmony" ? 1 : 0.55);
      ctx2d.fillRect(x, y - nh / 2, Math.max(2, x2 - x), nh);
      ctx2d.globalAlpha = 1;

      if (sel) {
        ctx2d.strokeStyle = COLORS.selBorder;
        ctx2d.lineWidth = 1.5;
        ctx2d.strokeRect(x - 1, y - nh / 2 - 1, Math.max(2, x2 - x) + 2, nh + 2);
      } else {
        ctx2d.strokeStyle = COLORS.noteBorder;
        ctx2d.lineWidth = 1;
        ctx2d.strokeRect(x, y - nh / 2, Math.max(2, x2 - x), nh);
      }

      // 频率标签（选中文件且缩放足够）
      if (isSelFile && view.pxPerBeat > 40 && (x2 - x) > 44) {
        const f = Tuning.centsToFreq(n.cents, Tuning.getA4());
        ctx2d.fillStyle = "rgba(255,255,255,0.85)";
        ctx2d.font = "9px " + (getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono") || "monospace");
        ctx2d.textBaseline = "middle";
        ctx2d.fillText(f.toFixed(1) + "Hz", x + 3, y - nh / 2 - 6);
      }
    }
  }

  function drawMarquee(w, h) {
    if (!marquee) return;
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    const rw = Math.abs(marquee.x1 - marquee.x0), rh = Math.abs(marquee.y1 - marquee.y0);
    ctx2d.fillStyle = "rgba(122,92,221,0.15)";
    ctx2d.fillRect(x, y, rw, rh);
    ctx2d.strokeStyle = "rgba(160,130,255,0.9)";
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(x + 0.5, y + 0.5, rw, rh);
  }

  function drawAlignIndicator(w, h) {
    if (!altAlign) return;
    const y = yOfCents(altAlign.targetCents);
    ctx2d.strokeStyle = COLORS.alignLine;
    ctx2d.setLineDash([4, 4]);
    ctx2d.beginPath();
    ctx2d.moveTo(0, y); ctx2d.lineTo(w, y);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
  }

  function drawPlayhead(w, h) {
    // 游动播放头竖线
    const x = beatToX(playheadBeat);
    if (x >= -8 && x <= w + 8) {
      ctx2d.fillStyle = COLORS.playhead;
      ctx2d.fillRect(x, 0, 1.5, h);
    }
    // 编辑光标三角标记（常驻不动，播放时不跟随）
    const cx = beatToX(editCursorBeat);
    if (cx >= -8 && cx <= w + 8) {
      ctx2d.fillStyle = COLORS.playhead;
      ctx2d.beginPath();
      ctx2d.moveTo(cx - 5, 0);
      ctx2d.lineTo(cx + 6, 0);
      ctx2d.lineTo(cx + 0.75, 8);
      ctx2d.closePath();
      ctx2d.fill();
    }
  }

  /* ---------- 命中测试 ---------- */
  function hitTest(beat, cents, fileFilter) {
    if (!scene) return null;
    // 从后往前（后绘制的优先）；fileFilter 缺省 = 仅当前编辑文件
    const files = fileFilter ? fileFilter() : (() => {
      if (!activeFile) return [];
      if (activeFile.type === "harmony") return [scene.harmony];
      return [activeFile];
    })();

    for (const f of files) {
      for (let i = f.notes.length - 1; i >= 0; i--) {
        const n = f.notes[i];
        const x = beatToX(n.start), x2 = beatToX(n.start + n.dur);
        const y = yOfCents(n.cents);
        const nh = Math.max(3, yOfCents(n.cents - 25) - yOfCents(n.cents + 25));   // ★ 高度减半
        if (beat >= n.start && beat <= n.start + n.dur &&
            Math.abs(cents - n.cents) < view.centsSpan / canvas.clientHeight * 6) {
          const xb = beatToX(beat);
          return { file: f, note: n, nearRight: (x2 - xb) < 6, nearLeft: (xb - x) < 6 };
        }
      }
    }
    return null;
  }

  /** 鼠标位置处所有文件中的音符（用于 Alt 音高对齐，含灰色和声） */
  function noteUnderMouseAnyFile(beat, cents, excludeNote) {
    const hit = hitTest(beat, cents, () => Model.sceneFiles(scene));
    return hit && hit.note !== excludeNote ? hit : null;
  }

  /* ---------- 交互 ---------- */
  function mousePos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!scene || !activeFile) return;
    const { x, y } = mousePos(e);
    const beat = xToBeat(x), cents = centsOfY(y);
    const hit = hitTest(beat, cents);

    if (e.button === 2) { // 右键删除
      if (hit) {
        const arr = hit.file.notes;
        const i = arr.indexOf(hit.note);
        if (i >= 0) arr.splice(i, 1);
        selected.delete(hit.note.id);
        afterEdit();
      }
      return;
    }

    if (hit) {
      // 点中的音符已在选中集 → 保持整组选中（拖一个带全部）；否则单选
      if (!selected.has(hit.note.id)) {
        selected.clear();
        selected.add(hit.note.id);
      }
      // ★ 修饰键模式：Shift=整组平移；Ctrl=整组复制后移动；右边缘=时值伸缩
      //   Alt 不再决定模式：拖动中按住 Alt 实时吸附（见 mousemove），Alt+Shift 同按 = 不吸附
      const mode = (e.shiftKey || (hit.nearRight && !e.altKey)) ? "resize" : "move";
      // ★ Shift 一律平移（起点跟着移，时值不变）；时值伸缩只走右边缘（无 Shift）
      const shiftFromLeft = e.shiftKey;

      // ★ Ctrl：先把整组选中音符各复制一份，拖的是副本组
      if ((e.ctrlKey || e.metaKey)) {
        const copies = [];
        for (const n of getSelected().filter(x => hit.file.notes.includes(x))) {
          const c = Model.makeNote(n.start, n.dur, n.cents, n.vel);
          hit.file.notes.push(c);
          copies.push({ n: c, start: c.start, cents: c.cents, dur: c.dur });
        }
        if (copies.length) {
          selected.clear();
          for (const c of copies) selected.add(c.n.id);
          drag = {
            mode: "move", file: hit.file, note: copies[0].n, group: copies,
            startBeat: beat, startCents: cents,
            origStart: copies[0].n.start, origDur: copies[0].n.dur, origCents: copies[0].n.cents,
          };
          fireSelection();
          draw();
          return;
        }
      }

      // ★ 整组拖动：记录所有选中音符的原位置（同文件内）
      const group = mode === "move"
        ? getSelected().filter(n => hit.file.notes.includes(n))
            .map(n => ({ n, start: n.start, cents: n.cents }))
        : [];
      // ★ Shift 整组改时值：记录每个音符原时值（拖左边缘时也记原起点）
      if (mode === "resize") {
        const g = getSelected().filter(n => hit.file.notes.includes(n))
          .map(n => ({ n, dur: n.dur, start: n.start }));
        drag = {
          mode, file: hit.file, note: hit.note, group: g, shiftFromLeft,
          startBeat: beat, startCents: cents,
          origStart: hit.note.start, origDur: hit.note.dur, origCents: hit.note.cents,
        };
      } else {
        drag = {
          mode, file: hit.file, note: hit.note, group,
          startBeat: beat, startCents: cents,
          origStart: hit.note.start, origDur: hit.note.dur, origCents: hit.note.cents,
        };
      }
    } else {
      // ★ 空白处按下：框选（REAPER 式橡皮筋）；Ctrl 按住 = 追加多选，否则重新选
      marquee = { x0: x, y0: y, x1: x, y1: y, add: e.ctrlKey || e.metaKey };
      if (!marquee.add) selected.clear();
      drag = null;
    }
    fireSelection();
    draw();
  });

  canvas.addEventListener("mousemove", (e) => {
    const { x, y } = mousePos(e);
    const beat = xToBeat(x), cents = centsOfY(y);

    // ★ 框选拖动中：更新橡皮筋 + 实时选中框内音符
    if (marquee) {
      marquee.x1 = x; marquee.y1 = y;
      const b1 = xToBeat(Math.min(marquee.x0, marquee.x1));
      const b2 = xToBeat(Math.max(marquee.x0, marquee.x1));
      const c1 = centsOfY(Math.max(marquee.y0, marquee.y1));
      const c2 = centsOfY(Math.min(marquee.y0, marquee.y1));
      if (!marquee.add) selected.clear();
      for (const n of activeFile.notes) {
        // 音符与框相交：时间重叠 + 音高带（±25 cents）重叠
        if (n.start < b2 && n.start + n.dur > b1 && n.cents + 25 >= c1 && n.cents - 25 <= c2)
          selected.add(n.id);
      }
      fireSelection();
      requestDraw();
      return;
    }

    if (!drag) {
      // hover 光标
      const hit = hitTest(beat, cents);
      canvas.style.cursor = hit ? (hit.nearRight ? "ew-resize" : "move") : "crosshair";
      return;
    }

    if (drag.mode === "move") {
      const dBeat = beat - drag.startBeat;
      const dCents = cents - drag.startCents;
      // ★ Alt 动态吸附：拖动中按住 Alt（且没同时按 Shift）→ 时间位置就地冻结
      //   （保持按下 Alt 那一刻的位置），只纵向吸附音高到鼠标处音符/律制音级，
      //   组内其余保持音程；松开 Alt 立即恢复自由移动
      const altSnap = e.altKey && !e.shiftKey;
      if (altSnap) {
        if (!drag.altFrozen) drag.altFrozen = { start: drag.note.start, groupStarts: drag.group ? drag.group.map(g => g.n.start) : null };
        const f = drag.altFrozen;
        let target;
        const under = noteUnderMouseAnyFile(beat, cents, drag.note);
        target = under ? under.note.cents : Tuning.snap(cents).cents;
        altAlign = { targetCents: target };
        const snapCents = target - drag.origCents;
        if (drag.group && drag.group.length > 1) {
          drag.group.forEach((g, i) => {
            g.n.start = f.groupStarts[i];
            g.n.cents = g.cents + snapCents;
            clampNote(g.n);
          });
        } else {
          drag.note.start = f.start;
          drag.note.cents = target;
          clampNote(drag.note);
        }
      } else if (tuningSnap) {
        // ★ 自动吸附律制（顶栏开关，与 Alt 无关）：时间正常跟手，
        //   只有音高吸附到当前律制音级（每个音符各自吸附，不保持组内音程）
        altAlign = null;
        if (drag.group && drag.group.length > 1) {
          for (const g of drag.group) {
            g.n.start = Math.max(0, snapTime(g.start + dBeat));
            g.n.cents = Tuning.snap(g.cents + dCents).cents;
            clampNote(g.n);
          }
        } else {
          drag.note.start = Math.max(0, snapTime(drag.origStart + dBeat));
          drag.note.cents = Tuning.snap(drag.origCents + dCents).cents;
          clampNote(drag.note);
        }
      } else {
        drag.altFrozen = null;
        altAlign = null;
        // ★ 整组移动：所有选中音符跟随拖动的音符一起动
        if (drag.group && drag.group.length > 1) {
          for (const g of drag.group) {
            g.n.start = Math.max(0, snapTime(g.start + dBeat));
            g.n.cents = g.cents + dCents;
            clampNote(g.n);
          }
        } else {
          drag.note.start = Math.max(0, snapTime(drag.origStart + dBeat));
          drag.note.cents = drag.origCents + dCents;
          clampNote(drag.note);
        }
      }
    } else if (drag.mode === "resize") {
      const dBeat = beat - drag.startBeat;
      const step = project.snapEnabled ? gridStep() : 0;
      if (drag.shiftFromLeft) {
        // ★ Shift 拖左边缘：起点跟着移（整组平移，时值不变）
        const move = (n, origStart) => {
          let s = origStart + dBeat;
          if (step) s = Math.round(s / step) * step;
          n.start = Math.max(0, s);
        };
        if (drag.group && drag.group.length > 1) {
          for (const g of drag.group) move(g.n, g.start);
        } else {
          move(drag.note, drag.origStart);
        }
      } else {
        // ★ Shift 拖其他位置 / 直接拖右边缘：整组时值伸缩（起点不动）
        let dur = drag.origDur + dBeat;
        if (step) dur = Math.max(step, Math.round(dur / step) * step);
        dur = Math.max(0.05, dur);
        if (drag.group && drag.group.length > 1) {
          for (const g of drag.group) {
            let d = g.dur + dBeat;
            if (step) d = Math.max(step, Math.round(d / step) * step);
            g.n.dur = Math.max(0.05, d);
          }
        } else {
          drag.note.dur = dur;
        }
      }
    }
    afterEdit(false);
  });

  window.addEventListener("mouseup", () => {
    if (marquee) {
      marquee = null;
      fireSelection();
      requestDraw();
    }
    if (drag) {
      altAlign = null;
      drag = null;
      afterEdit(true);
    }
  });

  canvas.addEventListener("dblclick", (e) => {
    if (!scene || !activeFile) return;
    const { x, y } = mousePos(e);
    const beat = xToBeat(x), cents = centsOfY(y);
    const step = gridStep();
    const start = snapTime(beat);
    const dur = project.snapEnabled ? step : 1;
    const n = Model.makeNote(start, dur, cents, 100);
    activeFile.notes.push(n);
    selected.clear();
    selected.add(n.id);
    fireSelection();
    afterEdit();
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  /* ---------- 滚轮缩放 ---------- */
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    onEditorWheel(e);
  }, { passive: false });

  ruler.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = ruler.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (e.altKey) {
      // 时间横向缩放，以鼠标为中心（标尺不需要纵向）
      const anchorBeat = rulerXToBeat(x);
      const factor = Math.exp(-e.deltaY * 0.002);
      view.pxPerBeat = Math.min(1024, Math.max(8, view.pxPerBeat * factor));
      view.scrollBeat = anchorBeat - x / view.pxPerBeat;
      clampView();
    } else {
      // 横向滚动（标尺上滚轮 = 左右移动时间轴）
      view.scrollBeat += (e.deltaY + e.deltaX) / view.pxPerBeat;
      clampView();
    }
    requestDraw();
  }, { passive: false });

  function onEditorWheel(e) {
    const { x, y } = mousePos(e);
    if (e.ctrlKey || e.metaKey) {
      // 纵向缩放（频率），以鼠标为中心
      const anchorCents = centsOfY(y);
      const factor = Math.exp(-e.deltaY * 0.002);
      view.centsSpan = Math.min(12000, Math.max(300, view.centsSpan * factor));
      // 保持 anchor 不动
      const h = canvas.clientHeight;
      const t = 1 - y / h;
      view.centsCenter = anchorCents - (t - 0.5) * view.centsSpan;
      clampView();
    } else if (e.altKey) {
      // 横向缩放（时间），以鼠标为中心
      const anchorBeat = xToBeat(x);
      const factor = Math.exp(-e.deltaY * 0.002);
      view.pxPerBeat = Math.min(1024, Math.max(8, view.pxPerBeat * factor));
      view.scrollBeat = anchorBeat - x / view.pxPerBeat;
      clampView();
    } else {
      // 平移：滚轮上下滚动（deltaY），Shift+滚轮 或 deltaX 横向
      view.scrollBeat += (e.deltaX / view.pxPerBeat) + (e.shiftKey ? e.deltaY / view.pxPerBeat : 0);
      if (!e.shiftKey) {
        // 纵向滚动：移动 centsCenter（★ 反向：往下滚 = 视图往下 = 内容往上）
        view.centsCenter -= e.deltaY * (view.centsSpan / canvas.clientHeight);
      }
      clampView();
    }
    requestDraw();
  }

  /** 视口边界：起点不得为负，且不越过内容 */
  function clampView() {
    view.scrollBeat = Math.max(0, view.scrollBeat);
    // 纵向：centsCenter 限制在 midi 0-127 范围内（留半屏余量）
    const half = view.centsSpan / 2;
    const minC = Tuning.midiToCents(0) - half * 0.5;
    const maxC = Tuning.midiToCents(127) + half * 0.5;
    view.centsCenter = Math.max(minC, Math.min(maxC, view.centsCenter));
  }

  /** 拖动边界：音符 cents 限制在 midi 0-127，防止拖出失控 */
  function clampNote(n) {
    const min = Tuning.midiToCents(0), max = Tuning.midiToCents(127);
    n.cents = Math.max(min, Math.min(max, n.cents));
  }

  /* ---------- E：补全音程基频 ----------
   * 选中两个音符 → 音程拟合为 m/k（分子分母 <16、互质）→ 两音视为同一
   * 基频 f 的第 k/m 次泛音（f = 低音 − 1200·log2(k)）→ 向下补全泛音列上
   * 第 8、4、1 音（仅补 < k 的；同位已有音符则跳过，防重复按 E 叠加）。 */
  function completeHarmonics() {
    if (!activeFile) return;
    const sel = getSelected();
    // ★ 框选常会带进第 3 个音符（或跨文件时只选中 1 个）：取最低+最高两个拟合，
    //   中间音符忽略；不足 2 个时提示实际数量，方便排查。
    if (sel.length < 2) {
      App.toast(sel.length === 0
        ? "补全音程：请先选中两个音符（框选/点选，仅当前文件）"
        : `补全音程：只选中了 1 个音符（跨文件的框选不算，需同文件内 2 个）`);
      return;
    }
    let lo = 0, hi = 0;
    for (let i = 1; i < sel.length; i++) {
      if (sel[i].cents < sel[lo].cents) lo = i;
      if (sel[i].cents > sel[hi].cents) hi = i;
    }
    const low = sel[lo], high = sel[hi];
    const fit = Tuning.fitIntervalRatio(high.cents - low.cents, 15);
    if (!fit) return;
    const { m, k } = fit;
    if (Math.abs(fit.error) > 25) {
      App.toast(`音程拟合偏差过大（最近 ${m}/${k}，${Math.abs(fit.error).toFixed(1)}¢）`);
      return;
    }
    const fund = low.cents - 1200 * Math.log2(k);   // 基频位置（cents）
    const min = Tuning.midiToCents(0), max = Tuning.midiToCents(127);
    const added = [];
    for (const h of [8, 4, 1]) {
      if (h >= k) continue;                          // 只补低于低音泛音次的
      const cents = Math.max(min, Math.min(max, fund + 1200 * Math.log2(h)));
      if (activeFile.notes.some(n => n.start === low.start && Math.abs(n.cents - cents) < 0.5)) continue;
      added.push({ h, note: Model.makeNote(low.start, low.dur, cents, low.vel) });
    }
    if (!added.length) { App.toast(`${m}/${k}：低音已接近基音，无可补泛音`); return; }
    for (const a of added) activeFile.notes.push(a.note);
    afterEdit();
    App.toast(`${m}/${k}：已补全第 ${added.map(x => x.h).join("、")} 泛音（+${added.length} 音）`);
  }

  /* ---------- 键盘 ---------- */
  // ★ 劫持浏览器快捷键（插件环境不需要浏览器行为）：
  //   F5 刷新 / Ctrl+P 打印 / Ctrl+S 保存网页 / Ctrl+F 查找 / Ctrl+D 收藏
  //   Alt+Left/Right 前进后退 —— 全部吞掉
  window.addEventListener("keydown", (e) => {
    // ★ 快捷键用 e.code 判定（物理键位），CapsLock 开启时 e.key 变大写字母也不失效
    const key = (typeof e.code === "string" && e.code.startsWith("Key"))
      ? e.code.slice(3).toLowerCase()   // KeyZ → "z"（不受大小写影响）
      : (e.key || "").toLowerCase();
    if (Bridge.hasHost()) {
      if (e.key === "F5" || e.key === "F12") { e.preventDefault(); e.stopPropagation(); return; }
      if ((e.ctrlKey || e.metaKey) && ["p", "s", "f", "d", "g", "u"].includes(key)) {
        e.preventDefault(); e.stopPropagation();
        // Ctrl+S → 保存工程（语义重定向）
        if (key === "s") { App.toast("用顶栏「保存」按钮保存工程"); }
        return;
      }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault(); e.stopPropagation(); return;
      }
    }
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "z") {
      e.preventDefault();
      if (onUndo) onUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (key === "y" || (e.shiftKey && key === "z"))) {
      e.preventDefault();
      if (onRedo) onRedo();
      return;
    }
    if (e.code === "Space") {
      // ★ 焦点在按钮/复选框上时 Space 会变成「按下该控件」而不是播放。
      //   这里无条件接管：只要不在文本输入控件里，Space 一律 = 播放/停止
      e.preventDefault();
      e.stopPropagation();
      App.togglePlay();
      return;
    }
    // ★ W = 切换「吸附律制」（拖动时音高吸附律制音级）；Q = 切换「锁定律制窗锚点」
    //   无修饰键时才生效（不干扰 Ctrl+W 等浏览器/宿主快捷键）
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (key === "w") {
        setTuningSnap(!tuningSnap);
        const cb = document.getElementById("snap-tuning");
        if (cb) cb.checked = tuningSnap;
        if (onTuningSnapChange) onTuningSnapChange(tuningSnap);
        if (App && App.toast) App.toast(tuningSnap ? "吸附律制：开" : "吸附律制：关");
        e.preventDefault();
        return;
      }
      if (key === "q") {
        setAnchorLocked(!anchorLocked);
        const btn = document.getElementById("btn-anchor-lock");
        if (btn) btn.classList.toggle("on", anchorLocked);
        if (App && App.toast) App.toast(anchorLocked ? "律制窗锚点：已锁定" : "律制窗锚点：未锁定");
        e.preventDefault();
        return;
      }
      // ★ E = 补全音程基频：选中两音 → 拟合 m/k（<16）→ 向下补泛音 8/4/1
      if (key === "e") {
        completeHarmonics();
        e.preventDefault();
        return;
      }
    }
    if (!scene || !activeFile) return;

    if ((e.ctrlKey || e.metaKey) && key === "c") {
      clipboard = [...selected].map(id => activeFile.notes.find(n => n.id === id)).filter(Boolean)
        .map(n => ({ ...n }));
      if (clipboard.length) App.toast(`已复制 ${clipboard.length} 个音符`);
    } else if ((e.ctrlKey || e.metaKey) && key === "a") {
      // Ctrl+A 全选当前文件音符（★ 用 e.code 判定，CapsLock 开着也有效）
      selected.clear();
      for (const n of activeFile.notes) selected.add(n.id);
      fireSelection();
      draw();
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && key === "v") {
      if (clipboard.length) {
        // ★ REAPER 式：粘贴到编辑光标位置（★ 不用 playheadBeat：播放中
        //   播放头在游动，粘贴会贴到错误位置），最早音符对齐光标
        const minStart = Math.min(...clipboard.map(n => n.start));
        const cursor = Math.max(0, project.snapEnabled ? snapTime(editCursorBeat) : editCursorBeat);
        const newIds = [];
        for (const c of clipboard) {
          const n = Model.makeNote(cursor + (c.start - minStart), c.dur, c.cents, c.vel);
          activeFile.notes.push(n);
          newIds.push(n.id);
        }
        selected.clear();
        newIds.forEach(id => selected.add(id));
        afterEdit();
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (selected.size) {
        activeFile.notes = activeFile.notes.filter(n => !selected.has(n.id));
        selected.clear();
        afterEdit();
      }
    } else if (e.key === "Escape") {
      selected.clear();
      fireSelection();
      draw();
    }
  });

  /* ---------- API ---------- */
  function setProject(p) { project = p; }
  function setScene(s) { scene = s; selected.clear(); requestDraw(); }
  function setActiveFile(f) { activeFile = f; selected.clear(); fireSelection(); requestDraw(); }
  function getSelected() {
    if (!activeFile) return [];
    return activeFile.notes.filter(n => selected.has(n.id));
  }
  function getActiveFile() { return activeFile; }

  function setPlayhead(beat) { playheadBeat = beat; requestDraw(); }
  function setPlaying(p) { playing = p; }
  function setEditCursor(beat) { editCursorBeat = Math.max(0, beat); requestDraw(); }
  function getEditCursor() { return editCursorBeat; }

  /** 播放时由 App 每帧调用：播放头始终固定在画面中间，视口持续向左滚动 */
  function followPlayhead(beat) {
    playheadBeat = beat;
    const w = canvas.clientWidth;
    // 播放头钉在正中
    view.scrollBeat = Math.max(0, beat - (w / 2) / view.pxPerBeat);
    requestDraw();
  }

  function fireSelection() { if (onSelectionChange) onSelectionChange(); }

  function afterEdit(fire = true) {
    if (fire) {
      if (onChange) onChange();          // 完整提交：撤销入栈 + 推引擎 + 存盘
    } else if (onLightChange) {
      onLightChange();                   // 拖动中：只刷新检查器，不提交（防卡顿 + 撤销栈污染）
    }
    requestDraw();
  }

  let _raf = 0;
  function requestDraw() {
    if (_raf) return;
    _raf = 1;
    let done = false;
    const doDraw = () => {
      if (done) return;
      done = true;
      _raf = 0;
      draw();
    };
    requestAnimationFrame(doDraw);
    // 页面失焦时（如 VS Code 内嵌浏览器未聚焦）rAF 被暂停，
    // 挂起的绘制永不执行且 _raf 卡死 → 滚轮后必须点一下才刷新。
    // 用定时器兜底：rAF 100ms 内没跑就强制绘制。
    setTimeout(doDraw, 100);
  }

  function init(opts) {
    onChange = opts.onChange;
    onSelectionChange = opts.onSelectionChange;
    onPlayheadMove = opts.onPlayheadMove;
    onUndo = opts.onUndo || null;
    onRedo = opts.onRedo || null;
    onLightChange = opts.onLightChange || null;
    onTuningSnapChange = opts.onTuningSnapChange || null;

    // ★ 全局劫持：右键菜单（WebView 里会弹出浏览器菜单）+ Ctrl+滚轮（浏览器页面缩放）。
    //   capture 阶段拦截，任何组件（画布/标尺/列表/弹窗）上都生效。
    window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
    window.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    }, { passive: false, capture: true });

    // ★ 点击按钮/复选框后自动把焦点还给 body：
    //   否则焦点留在控件上，后续 Space/回车会重复触发该控件（Space 不能播放）
    //   ★ select 例外：mousedown 刚打开下拉列表，click 里 blur 会立刻把它关掉
    //     （律制/网格下拉一点开就消失的根因）。select 改为选完（change）后 blur。
    window.addEventListener("click", (e) => {
      const t = e.target.closest("button, input[type=checkbox], input[type=radio], a");
      if (t && typeof t.blur === "function") {
        setTimeout(() => t.blur(), 0);
      }
      // 点在 select 外面：把残留焦点的 select 还给 body（点 select 自身不动，
      // 否则会把刚打开的下拉列表关掉）
      const ae = document.activeElement;
      if (ae && ae.tagName === "SELECT" && e.target !== ae && !ae.contains(e.target)) {
        ae.blur();
      }
    }, true);
    window.addEventListener("change", (e) => {
      if (e.target && e.target.tagName === "SELECT") e.target.blur();
    }, true);

    resize();
    KeyColumn.resize(canvas.clientHeight);
    TuningColumn.resize(canvas.clientHeight);
    window.addEventListener("resize", () => {
      resize();
      KeyColumn.resize(canvas.clientHeight);
      TuningColumn.resize(canvas.clientHeight);
      requestDraw();
    });
    draw();
  }

  function getView() { return view; }
  function setAnchorLocked(v) { anchorLocked = !!v; requestDraw(); }
  function setTuningSnap(v) { tuningSnap = !!v; requestDraw(); }

  /* ---------- 横向滚动条 ---------- */
  const hscroll = document.getElementById("hscroll");
  let hscrollDrag = null;
  function hscrollPaint() {
    const w = hscroll.clientWidth, h = hscroll.clientHeight;
    const g = hscroll.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    if (hscroll.width !== w * dpr) { hscroll.width = w * dpr; hscroll.height = h * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // 内容范围：0 到 maxBeat
    let maxBeat = 16;
    if (scene) {
      for (const f of Model.sceneFiles(scene)) {
        for (const n of f.notes) maxBeat = Math.max(maxBeat, n.start + n.dur);
      }
    }
    maxBeat += 4;
    const totalW = maxBeat * view.pxPerBeat;
    const thumbW = Math.max(24, Math.min(w, w * (w / totalW)));
    const maxScroll = Math.max(0, totalW - w);
    const t = maxScroll > 0 ? view.scrollBeat * view.pxPerBeat / maxScroll : 0;
    const x = t * (w - thumbW);
    g.fillStyle = "rgba(131,136,165,0.35)";
    g.beginPath();
    g.roundRect(x, 2, thumbW, h - 4, 3);
    g.fill();
    hscroll._metric = { maxBeat, totalW, maxScroll, w };
  }
  function hscrollHit(e) {
    const r = hscroll.getBoundingClientRect();
    const x = e.clientX - r.left;
    const m = hscroll._metric;
    const thumbW = Math.max(24, Math.min(m.w, m.w * (m.w / m.totalW)));
    return { x, thumbW, m };
  }
  hscroll.addEventListener("mousedown", (e) => {
    const { x, thumbW, m } = hscrollHit(e);
    if (m.maxScroll <= 0) return;
    const t = Math.max(0, Math.min(1, (x - thumbW / 2) / (m.w - thumbW)));
    view.scrollBeat = Math.max(0, t * m.maxScroll / view.pxPerBeat);
    hscrollDrag = { grabX: x };
    requestDraw();
  });
  window.addEventListener("mousemove", (e) => {
    if (!hscrollDrag) return;
    const { x, thumbW, m } = hscrollHit(e);
    const t = Math.max(0, Math.min(1, (x - thumbW / 2) / (m.w - thumbW)));
    view.scrollBeat = Math.max(0, t * m.maxScroll / view.pxPerBeat);
    requestDraw();
  });
  window.addEventListener("mouseup", () => { hscrollDrag = null; });

  return {
    init, draw, requestDraw, resize,
    setProject, setScene, setActiveFile,
    getSelected, getActiveFile, getView,
    setAnchorLocked, setTuningSnap,
    setPlayhead, setPlaying, followPlayhead,
    setEditCursor, getEditCursor,
    getLoop, clearLoop,
    yOfCents, centsOfY, beatToX, xToBeat,
    getPlayhead: () => playheadBeat,
  };
})();

/* ============================================================
 * GoodJust — tuningcolumn.js
 * 律制钢琴窗：与左侧 12-TET 音名键列对齐的第二个竖排窗，
 * 显示当前律制的音级（JI 比率 / 自定义比率 / 12-TET 时隐藏）。
 * ============================================================ */
"use strict";

const TuningColumn = (() => {

  const canvas = document.getElementById("tuningcolumn");
  const ctx2d = canvas.getContext("2d");
  const WIDTH = 64;

  function resize(viewH) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = WIDTH + "px";
    canvas.style.height = viewH + "px";
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * view: { yOfCents(cents)->y }, anchorCents: 1/1 锚点（所选音符音高或 C4）
   * 绘制当前律制在可视范围内的音级格子。
   */
  function draw(view, anchorCents) {
    const h = canvas.height / (window.devicePixelRatio || 1);
    ctx2d.clearRect(0, 0, WIDTH, h);
    const t = Tuning.getTuning();

    // 12-TET 无独立律制窗
    if (t === Tuning.TUNINGS["12tet"]) return;

    ctx2d.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-background-dark").trim() || "#1E1F25";
    ctx2d.fillRect(0, 0, WIDTH, h);

    ctx2d.font = "9px " + (getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono").trim() || "monospace");
    ctx2d.textBaseline = "middle";
    ctx2d.textAlign = "left";

    const a4 = Tuning.getA4();
    const ratios = t.ratios;
    const nPerOct = ratios.length;
    // 以 1/1（锚点）为中心上下镜像对称：上方画 v，下方画 1/v（倒数）
    const items = [];
    // 1/1 系列：每个八度一行
    for (let oct = -2; oct <= 2; oct++) {
      items.push({ cents: anchorCents + 1200 * oct, label: "1/1", isAnchor: oct === 0, isOct: true });
    }
    // 其他音级：上方 anchor + c，下方 anchor - c（标签为倒数）
    const invertLabel = (r) => Array.isArray(r) ? `${r[1]}/${r[0]}` : "1/" + Tuning.ratioLabel(r);
    for (let oct = 0; oct <= 2; oct++) {
      for (let d = 1; d < nPerOct; d++) {
        const r = ratios[d];
        const v = Tuning.ratioValue(r);
        const c = 1200 * oct + 1200 * Math.log2(v);
        if (c <= 0) continue;
        items.push({ cents: anchorCents + c, label: Tuning.ratioLabel(r) });
        items.push({ cents: anchorCents - c, label: invertLabel(r) });
      }
    }
    for (const it of items) {
      const midiF = Tuning.centsToMidiFloat(it.cents, a4);
      if (midiF < 0 || midiF > 127) continue;
      const y = view.yOfCents(it.cents);
      if (y < -20 || y > h + 20) continue;
      const cellH = Math.max(1, view.yOfCents(it.cents + 50) - view.yOfCents(it.cents - 50) - 1);
      // 方格（1/1 行高亮）
      ctx2d.fillStyle = it.isAnchor ? "rgba(122,92,221,0.55)" : "rgba(122,92,221,0.18)";
      ctx2d.fillRect(2, y - cellH / 2, WIDTH - 4, cellH);
      // 标签
      ctx2d.fillStyle = it.isAnchor ? "#ffffff" : (it.isOct ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)");
      ctx2d.fillText(it.label, 5, y);
      if (it.isOct) {
        ctx2d.fillStyle = it.isAnchor ? "rgba(255,255,255,0.6)" : "rgba(122,92,221,0.35)";
        ctx2d.fillRect(2, y + cellH / 2, WIDTH - 4, 1);
      }
    }
  }

  return { resize, draw, WIDTH };
})();

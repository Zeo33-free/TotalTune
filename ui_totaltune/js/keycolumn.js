/* ============================================================
 * GoodJust — keycolumn.js
 * 左侧音名键列：竖排 128 个小方格（midi note 0-127 音名），
 * 无黑白键之分。与主编辑器共享纵向视口（对数频率轴）。
 * ============================================================ */
"use strict";

const KeyColumn = (() => {

  const canvas = document.getElementById("keycolumn");
  const ctx2d = canvas.getContext("2d");
  const WIDTH = 56;

  function resize(viewH) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = WIDTH + "px";
    canvas.style.height = viewH + "px";
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * view: { centsTop, centsBottom, yOfCents(cents)->y }
   * 绘制 0-127 每个音名的方格。
   */
  function draw(view) {
    const h = canvas.height / (window.devicePixelRatio || 1);
    ctx2d.clearRect(0, 0, WIDTH, h);
    ctx2d.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-background-dark").trim() || "#1E1F25";
    ctx2d.fillRect(0, 0, WIDTH, h);

    ctx2d.font = "9px " + getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono").trim() || "monospace";
    ctx2d.textBaseline = "middle";
    ctx2d.textAlign = "left";

    const a4 = Tuning.getA4();
    for (let midi = 0; midi <= 127; midi++) {
      const cents = Tuning.midiToCents(midi, a4);
      const y = view.yOfCents(cents);
      if (y < -20 || y > h + 20) continue;
      const cellH = Math.max(1, view.yOfCents(cents + 50) - view.yOfCents(cents - 50) - 1);
      // 方格
      ctx2d.fillStyle = "rgba(131,136,165,0.10)";
      ctx2d.fillRect(2, y - cellH / 2, WIDTH - 4, cellH);
      // 音名
      ctx2d.fillStyle = midi % 12 === 0 ? "#ffffff" : "rgba(255,255,255,0.55)";
      ctx2d.fillText(Tuning.midiName(midi), 6, y);
      // C 行强调线
      if (midi % 12 === 0) {
        ctx2d.fillStyle = "rgba(131,136,165,0.25)";
        ctx2d.fillRect(2, y + cellH / 2, WIDTH - 4, 1);
      }
    }
  }

  return { resize, draw, WIDTH };
})();

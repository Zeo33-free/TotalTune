/* ============================================================
 * GoodJust — tuning.js
 * 纯律 / 律制数学。
 * 统一约定：cents = 1200 * log2(freq / A4)，即 A4(midi 69) = 0 cents。
 * freq = A4 * 2^(cents/1200)
 * 律制：12-TET / JI（1/1 锚定 C4）/ 自定义（比率表）
 * ============================================================ */
"use strict";

const Tuning = (() => {

  const A4_DEFAULT = 440;

  /** cents <-> Hz（cents 相对当前 A4） */
  function centsToFreq(cents, a4 = A4_DEFAULT) {
    return a4 * Math.pow(2, cents / 1200);
  }
  function freqToCents(freq, a4 = A4_DEFAULT) {
    return 1200 * Math.log2(freq / a4);
  }

  /** MIDI note 0-127 → cents（A4=69 → 0） */
  function midiToCents(midi, a4 = A4_DEFAULT) {
    return (midi - 69) * 100;
  }
  /** cents → MIDI 浮点号 */
  function centsToMidiFloat(cents, a4 = A4_DEFAULT) {
    return cents / 100 + 69;
  }

  /** 音名（含八度），C4=60 */
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  function midiName(midi) {
    const n = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[n] + oct;
  }

  /** cents 相对最近 12-TET 音级的偏移（用于显示 "+13.7¢"） */
  function centsOffsetFromTET(cents) {
    const nearest = Math.round(cents / 100) * 100;
    return cents - nearest;
  }
  function fmtOffset(cents) {
    const o = centsOffsetFromTET(cents);
    if (Math.abs(o) < 0.05) return "0¢";
    return (o > 0 ? "+" : "") + o.toFixed(1) + "¢";
  }

  /* ---------------- 律制定义 ---------------- */

  // JI 音级比率（八度等价，1/1 锚定 C4）——★ 用户指定的默认表（17 音级）
  const JI_RATIOS = [
    [1, 1], [9, 8], [8, 7], [7, 6], [6, 5], [11, 9], [5, 4],
    [9, 7], [4, 3], [11, 8], [7, 5], [10, 7], [3, 2], [8, 5],
    [13, 8], [5, 3], [12, 7], [7, 4],
  ];

  const TUNINGS = {
    "12tet": {
      name: "12-TET",
      ratios: null,
      degreeToCents(degree, octave, a4) {
        return midiToCents((octave + 1) * 12 + degree, a4);
      },
      snap(cents, a4) {
        const midi = Math.round(centsToMidiFloat(cents, a4));
        return { cents: midiToCents(midi, a4), midi, ratio: null, label: null };
      },
      ratioText() { return "12-TET：2^(n/12)，无有理数比率"; },
    },
    "ji": {
      name: "JI",
      ratios: JI_RATIOS,
      degreeToCents(degree, octave, a4) {
        const n12 = JI_RATIOS.length;
        const idx = ((degree % n12) + n12) % n12;
        const v = ratioValue(JI_RATIOS[idx]);
        return anchor + 1200 * (octave + Math.floor(degree / n12))
          + 1200 * Math.log2(v);
      },
      snap(cents, a4) { return snapToRatios(cents, a4, JI_RATIOS); },
      ratioText() { return JI_RATIOS.map((r, i) => `${i}: ${ratioLabel(r)}`).join("  "); },
    },
    "custom": {
      name: "自定义",
      ratios: [], // number / [n,d] / {v,label} 混合，每八度音级
      degreeToCents(degree, octave, a4) {
        const rs = TUNINGS.custom.ratios;
        const n = rs.length;
        if (!n) return anchor;
        const idx = ((degree % n) + n) % n;
        return anchor + 1200 * (octave + Math.floor(degree / n))
          + 1200 * Math.log2(ratioValue(rs[idx]));
      },
      snap(cents, a4) { return snapToRatios(cents, a4, TUNINGS.custom.ratios); },
      ratioText() {
        const rs = TUNINGS.custom.ratios;
        if (!rs.length) return "自定义律制：未定义（顶栏选择「自定义…」）";
        return rs.map((r, i) => `${i}: ${ratioLabel(r)}`).join("  ");
      },
    },
  };

  /** 比率项统一取值：兼容 number / [n,d] / {v,label} */
  function ratioValue(r) {
    if (Array.isArray(r)) return r[0] / r[1];
    if (typeof r === "number") return r;
    return r.v;
  }
  function ratioLabel(r) {
    if (Array.isArray(r)) return `${r[0]}/${r[1]}`;
    if (typeof r === "number") return String(r);
    return r.label || String(r.v);
  }

  /** 比率吸附：在邻近八度内找最近的音级。1/1 锚定 anchor（选中音符后 = 音符音高，否则 C4） */
  function snapToRatios(cents, a4, ratios) {
    const base = anchor;
    const n = ratios.length;
    if (!n) return { cents, midi: null, ratio: null, label: null };
    const rel = cents - base;
    const oct = Math.floor(rel / 1200);
    let best = null;
    for (let o = -1; o <= 1; o++) {
      for (let i = 0; i < n; i++) {
        const r = ratios[i];
        const v = ratioValue(r);
        const c = base + 1200 * (oct + o) + 1200 * Math.log2(v);
        const dist = Math.abs(c - cents);
        if (!best || dist < best.dist) {
          best = {
            dist, cents: c,
            ratio: Array.isArray(r) ? r : null,
            label: ratioLabel(r),
            degree: i, octave: oct + o,
          };
        }
      }
    }
    return { cents: best.cents, midi: null, ratio: best.ratio, label: best.label, degree: best.degree, octave: best.octave };
  }

  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  /** 音程拟合：把 cents 差拟合成互质比率 m/k（1 ≤ k < m ≤ maxN）。
   *  返回 { m, k, cents, error }，error = 拟合 cents − 实际 cents。
   *  迭代序保证误差相同时取最小分子分母。 */
  function fitIntervalRatio(deltaCents, maxN = 15) {
    let best = null;
    for (let m = 2; m <= maxN; m++) {
      for (let k = 1; k < m; k++) {
        if (gcd(m, k) !== 1) continue;
        const c = 1200 * Math.log2(m / k);
        const err = c - deltaCents;
        if (!best || Math.abs(err) < Math.abs(best.error)) {
          best = { m, k, cents: c, error: err };
        }
      }
    }
    return best;
  }

  let current = TUNINGS["12tet"];
  let currentA4 = A4_DEFAULT;
  /** JI/自定义律制的 1/1 锚点（cents）。选中音符时 = 音符音高，否则 C4 */
  let anchor = midiToCents(60, A4_DEFAULT);

  function setTuning(key) { if (TUNINGS[key]) current = TUNINGS[key]; }
  function setA4(v) { currentA4 = v; }
  function setAnchor(cents) { anchor = cents; }
  function getAnchor() { return anchor; }
  function setCustomRatios(list) { TUNINGS.custom.ratios = list || []; }
  function getTuning() { return current; }
  function getA4() { return currentA4; }
  function snap(cents) { return current.snap(cents, currentA4); }

  return {
    centsToFreq, freqToCents, midiToCents, centsToMidiFloat,
    midiName, centsOffsetFromTET, fmtOffset,
    TUNINGS, setTuning, setA4, getTuning, getA4, snap, setCustomRatios,
    setAnchor, getAnchor, ratioValue, ratioLabel, fitIntervalRatio,
  };
})();

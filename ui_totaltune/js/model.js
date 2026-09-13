/* ============================================================
 * GoodJust — model.js
 * 数据模型：Project / Scene / File(Harmony|Melody) / Note
 * 音高以 cents 存储（相对 A4），时间以 beat（拍）存储。
 * ============================================================ */
"use strict";

const Model = (() => {

  let _nextId = 1;
  function nextId() { return _nextId++; }
  function setNextId(v) { _nextId = Math.max(_nextId, v + 1); }

  /* ---------------- Note ---------------- */
  // { id, start, dur, cents, vel }
  function makeNote(start, dur, cents, vel = 100) {
    return { id: nextId(), start, dur, cents, vel };
  }

  /* ---------------- File ---------------- */
  const FILE_TYPES = { HARMONY: "harmony", MELODY: "melody", BASS: "bass" };

  // ★ 导出/拖拽用的固定 ASCII 文件名（用户要求：mid 文件名只用 ASCII）。
  //   显示名（中文）只在 UI 里用；scene 名仍可自定义。
  function asciiFileName(file) {
    switch (file.type) {
      case FILE_TYPES.BASS:    return `bass${file.id}`;
      case FILE_TYPES.HARMONY: return `chord${file.id}`;
      default:                 return `md${file.id}`;   // melody
    }
  }

  function makeFile(type, name) {
    return {
      id: nextId(),
      type,            // harmony | melody | bass
      name,
      notes: [],
      color: null,     // 由 UI 分配
    };
  }

  /* ---------------- Scene ---------------- */
  function makeScene(name) {
    const harmony = makeFile(FILE_TYPES.HARMONY, "和声");
    return {
      id: nextId(),
      name,
      harmony,
      melodies: [],   // melody files
      // 和声文本（弹窗编辑用），形如 "0:0,4,7,11\n5:0,3,7"
      harmonyText: "",
    };
  }

  function sceneFiles(scene) {
    return [scene.harmony, ...scene.melodies];
  }
  function findFile(scene, fileId) {
    return sceneFiles(scene).find(f => f.id === fileId) || null;
  }

  /* ---------------- 和声文本解析 ---------------- */
  /**
   * "0:0,4,7,11\n4:0,3,7" → 和声音符（每和弦 1 拍，C4 起根音）
   * 根音为 MIDI 半音数（相对 C4），音程为半音数（支持小数=微音）。
   */
  function parseHarmonyText(text) {
    const notes = [];
    let bar = 0;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(-?\d+(?:\.\d+)?)\s*:\s*(.+)$/);
      if (!m) continue;
      const root = parseFloat(m[1]);
      const ivs = m[2].split(",").map(s => parseFloat(s.trim())).filter(v => !isNaN(v));
      const start = bar * 1.0;
      const C4 = Tuning.midiToCents(60);
      notes.push(makeNote(start, 1.0, C4 + root * 100, 100));
      for (const iv of ivs) {
        if (iv === 0) continue;
        notes.push(makeNote(start, 1.0, C4 + (root + iv) * 100, 100));
      }
      bar++;
    }
    return notes;
  }

  function harmonyToText(scene) {
    // 由和声音符反推文本（按 start 聚类）
    const h = scene.harmony.notes.slice().sort((a, b) => a.start - b.start || a.cents - b.cents);
    const lines = [];
    let cur = null;
    for (const n of h) {
      const root = Math.round((n.cents - Tuning.midiToCents(60)) / 100);
      if (!cur || Math.abs(n.start - cur.start) > 0.01) {
        cur = { start: n.start, root, ivs: [] };
        lines.push(cur);
      } else {
        // ★ 存相对根音的音程（parse 时用 root+iv 还原）；
        //   旧版存绝对半音数，转位和弦（最低音≠根音）反推再解析会变错音
        cur.ivs.push(root - cur.root);
      }
    }
    return lines.map(l => `${l.root}:${l.ivs.join(",")}`).join("\n");
  }

  /* ---------------- 旋律文本解析 ---------------- */
  const _NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  /** 音高 token → cents：MIDI 号（60=C4，可小数=微音）或音名（C4/D#3/Eb4，可带 ±音分如 C4+35） */
  function parsePitchToken(tok) {
    if (/^-?\d+(?:\.\d+)?$/.test(tok))
      return Tuning.midiToCents(parseFloat(tok));
    const m = tok.match(/^([A-Ga-g])([#b]?)(-?\d+)(?:\s*([+-])\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    const idx = _NOTE_NAMES.indexOf(m[1].toUpperCase());
    const acc = m[2] === "#" ? 1 : (m[2] === "b" ? -1 : 0);
    let cents = Tuning.midiToCents(12 * (parseInt(m[3], 10) + 1) + idx + acc);
    if (m[4]) cents += (m[4] === "-" ? -1 : 1) * parseFloat(m[5]);
    return cents;
  }

  /**
   * 每行一个音符：开始:时值:音高[:力度]（时值省略=1 拍，力度省略=100）
   * "# 开头为注释。例：0:1:60 / 1:0.5:D#4 / 2:2:C4+35 / 4::64:80
   */
  function parseMelodyText(text) {
    const notes = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      // ★ 保留空字段："4::64:80"（省略时值）依赖位置对齐，
      //   旧版 filter 掉空串导致 start/dur/音高/力度全部错位
      const parts = t.split(":").map(s => s.trim());
      if (parts.length < 2) continue;
      const start = parseFloat(parts[0]);
      if (isNaN(start)) continue;
      let dur = 1.0, vel = 100, tok;
      if (parts.length >= 3) {
        const d = parts[1] ? parseFloat(parts[1]) : NaN;
        if (!isNaN(d)) dur = Math.max(0.05, d);
        tok = parts[2];
        if (parts[3]) {
          const v = parseInt(parts[3], 10);
          if (!isNaN(v)) vel = Math.min(127, Math.max(1, v));
        }
      } else {
        tok = parts[1];
      }
      const cents = parsePitchToken(tok);
      if (cents === null) continue;
      notes.push(makeNote(Math.max(0, start), dur, cents, vel));
    }
    return notes;
  }

  function _fmtBeat(v) { return String(Math.round(v * 1000) / 1000); }

  /** 旋律文件 → 文本（每行 开始:时值:音高，微音用音名±音分表示，力度≠100 才输出） */
  function melodyToText(file) {
    const ns = file.notes.slice().sort((a, b) => a.start - b.start || a.cents - b.cents);
    return ns.map(n => {
      const mf = Tuning.centsToMidiFloat(n.cents);
      const nearest = Math.round(mf);
      const off = Math.round((mf - nearest) * 1000) / 10;   // 音分，保留 1 位
      let pitch = Tuning.midiName(nearest);
      if (Math.abs(off) >= 0.05) pitch += (off > 0 ? "+" : "-") + Math.abs(off).toFixed(1);
      let line = `${_fmtBeat(n.start)}:${_fmtBeat(n.dur)}:${pitch}`;
      if (n.vel !== 100) line += `:${n.vel}`;
      return line;
    }).join("\n");
  }

  /* ---------------- Project ---------------- */
  function makeProject() {
    const p = {
      version: 1,
      bpm: 120,
      tuning: "12tet",
      a4: 440,
      snapEnabled: true,
      snapDenom: 4,
      snapTriplet: false,
      scenes: [],
    };
    p.scenes.push(makeScene("Scene 1"));
    return p;
  }

  /** 复制文件（深拷贝音符，新 id） */
  function cloneFile(file, newName) {
    const f = makeFile(file.type, newName || file.name + " 副本");
    f.notes = file.notes.map(n => ({ ...n, id: nextId() }));
    return f;
  }

  /** 复制 Scene（深拷贝） */
  function cloneScene(scene, newName) {
    const s = makeScene(newName || scene.name + " 副本");
    s.harmony.notes = scene.harmony.notes.map(n => ({ ...n, id: nextId() }));
    s.harmonyText = scene.harmonyText;
    s.melodies = scene.melodies.map(m => {
      const c = makeFile(FILE_TYPES.MELODY, m.name);
      c.notes = m.notes.map(n => ({ ...n, id: nextId() }));
      return c;
    });
    return s;
  }

  /** 添加旋律文件 */
  function addMelody(scene, name) {
    const f = makeFile(FILE_TYPES.MELODY, name || `旋律 ${scene.melodies.length + 1}`);
    scene.melodies.push(f);
    return f;
  }

  /** 删除旋律文件 */
  function removeMelody(scene, fileId) {
    const i = scene.melodies.findIndex(m => m.id === fileId);
    if (i >= 0) scene.melodies.splice(i, 1);
  }

  return {
    FILE_TYPES, makeNote, makeFile, makeScene, makeProject,
    sceneFiles, findFile, asciiFileName,
    parseHarmonyText, harmonyToText,
    parseMelodyText, melodyToText,
    cloneFile, cloneScene, addMelody, removeMelody,
    nextId, setNextId,
  };
})();

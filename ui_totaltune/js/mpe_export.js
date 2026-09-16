/* ============================================================
 * GoodJust — mpe_export.js
 * 导出 MPE MIDI（SMF 1）。
 * 每个文件 → 一个 MPE 通道族（member channels 1-15，global ch = 0）。
 * 音高：note 保持最近的 MIDI note，微音差用 MPE pitchbend 表达
 * （14bit，±2 半音范围 → 精度 4/16383 半音 ≈ 0.049¢）。
 * ============================================================ */
"use strict";

const MPEExport = (() => {

  /* ---------- varint / SMF 基础 ---------- */
  function writeVarlen(value) {
    const bytes = [value & 0x7f];
    value >>= 7;
    while (value > 0) {
      bytes.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    return bytes;
  }

  function str(s) { return Array.from(s, c => c.charCodeAt(0)); }
  function u32(v) { return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]; }
  function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }

  class Track {
    constructor() { this.events = []; } // {tick, bytes:[...]}
    add(tick, bytes) { this.events.push({ tick, bytes }); }
    /** 输出 MTrk chunk */
    build() {
      this.events.sort((a, b) => a.tick - b.tick);
      const data = [];
      let last = 0;
      for (const e of this.events) {
        for (const b of writeVarlen(e.tick - last)) data.push(b);
        last = e.tick;
        for (const b of e.bytes) data.push(b);
      }
      // End of track
      data.push(...writeVarlen(0), 0xff, 0x2f, 0x00);
      return [...str("MTrk"), ...u32(data.length), ...data];
    }
  }

  /* ---------- 音高 → MPE ---------- */
  const PB_RANGE = 2; // ±2 semitones

  /**
   * cents → { note, bend14 }（bend14: 0..16383，8192=中心）
   */
  function centsToNoteBend(cents, a4) {
    const midiFloat = Tuning.centsToMidiFloat(cents, a4);
    let note = Math.round(midiFloat);
    note = Math.max(0, Math.min(127, note));
    const semis = midiFloat - note;          // -0.5..0.5
    let bend = Math.round(8192 + (semis / PB_RANGE) * 8192);
    bend = Math.max(0, Math.min(16383, bend));
    return { note, bend };
  }

  /**
   * ★ 通道分配：选「空闲最久」的通道（endOf 最小者，从未用过视为 -1）。
   *   - 从未用过的通道最优先 → 音符自然轮铺 ch1-15，DAW 按通道分轨时
   *     均匀分散，不挤前几轨；
   *   - 都用过时选「上一个音符结束最早」的通道：它的 release 尾音衰减
   *     时间最长，新音符的 pitchbend 不会改变还在释放中的前一个音
   *     （note-off ≠ 声音停了，release 期间 pitchbend 仍生效）；
   *   - 全占用时同样偷结束最早的（重叠不可避免，选衰减最久的）。
   *   返回 Map(note对象 → member ch)。
   */
  function assignChannels(notes, members) {
    const sorted = notes.slice().sort((a, b) => a.start - b.start);
    const endOf = new Map();   // member ch → 该通道上一个音符的结束 tick
    const result = new Map();
    for (const n of sorted) {
      const startTick = Math.round(n.start * PPQ);
      const endTick = Math.max(startTick + 1, Math.round((n.start + n.dur) * PPQ));
      let ch = members[0], bestEnd = Infinity;
      for (const c of members) {
        const e = endOf.get(c) ?? -1;
        if (e < bestEnd) { bestEnd = e; ch = c; }
      }
      // bestEnd <= startTick：该通道已空闲且空闲最久（release 衰减最充分，安全复用）；
      // bestEnd >  startTick：全占用，偷结束最早的。
      endOf.set(ch, endTick);
      result.set(n, ch);
    }
    return result;
  }

  /* ---------- 导出 ---------- */
  const PPQ = 960;

  /** 单个文件 → MTrk（RPN0 + 音符）。传入 tr 时追加到该 track（不重复写 track 名） */
  function buildFileTrack(scene, file, a4, tr) {
    const t = tr || new Track();
    if (!tr) {
      const tname = str(`s${scene.id}/${Model.asciiFileName(file)}`);
      t.add(0, [0xff, 0x03, tname.length, ...tname]);
    }

    // RPN 0 (pitch bend range ±2)：★ MPE 规范只发 member ch 1-15，不碰全局 ch 0
    for (let c = 1; c <= 15; c++) {
      t.add(0, [0xb0 | c, 101, 0]);
      t.add(0, [0xb0 | c, 100, 0]);
      t.add(0, [0xb0 | c, 6, PB_RANGE]);
      t.add(0, [0xb0 | c, 38, 0]);
    }

    // ★ 通道分配：优先空闲最久的通道（轮铺 ch1-15 + 避开 release 尾音）
    const members = Array.from({ length: 15 }, (_, i) => 1 + i);
    const chOf = assignChannels(file.notes, members);
    const notes = file.notes.slice().sort((a, b) => a.start - b.start);
    for (const n of notes) {
      const ch = chOf.get(n);
      const startTick = Math.round(n.start * PPQ);
      const endTick = Math.max(startTick + 1, Math.round((n.start + n.dur) * PPQ));
      const { note, bend } = centsToNoteBend(n.cents, a4);

      // channel pressure (MPE: per-note expression)
      t.add(startTick, [0xd0 | ch, Math.round((n.vel / 127) * 127)]);

      // pitchbend (LSB, MSB)
      t.add(startTick, [0xe0 | ch, bend & 0x7f, (bend >> 7) & 0x7f]);
      t.add(startTick, [0x90 | ch, note, Math.max(1, Math.min(127, Math.round(n.vel)))]);
      t.add(endTick, [0x80 | ch, note, 0x40]);
    }
    return t;
  }

  /** 单文件导出（实时写出 / 拖拽）：SMF0 单 track（tempo+MPE+音符合一），lower zone ch1-15 */
  function exportFile(project, scene, file) {
    const a4 = project.a4 || 440;
    const bpm = project.bpm || 120;
    const tempoUsPerQuarter = Math.round(60000000 / bpm);

    const tr = new Track();
    tr.add(0, [0xff, 0x51, 0x03, (tempoUsPerQuarter >> 16) & 0xff, (tempoUsPerQuarter >> 8) & 0xff, tempoUsPerQuarter & 0xff]);
    // ★ ASCII track 名（中文会乱码）
    const name = str(Model.asciiFileName(file));
    tr.add(0, [0xff, 0x03, name.length, ...name]);
    // MPE management: lower zone, 15 member channels
    // ★ SysEx 长度必须含结尾 F7（之前少 1 → REAPER 解析报「打不开」）
    {
      const body = [0x7e, 0x7f, 0x0d, 0x01, 0x00, 15, 0x00];
      tr.add(0, [0xf0, body.length + 1, ...body, 0xf7]);
    }
    buildFileTrack(scene, file, a4, tr);   // RPN + 音符追加到同一 track
    // ★ format 0 = 单 track（之前声明 format0 却写了 2 个 MTrk → 拖进去两条轨道）
    const header = [...str("MThd"), ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ)];
    return new Uint8Array([...header, ...tr.build()]).buffer;
  }

  /**
   * project → ArrayBuffer (.mid)
   * 每个文件分配一个 MPE 通道族：
   *   global channel = 15*(familyIndex % 8)  (0,15,30,45,...)
   *   member channels = global+1 .. global+15
   * 音符轮流分配 member channel。
   */
  function exportProject(project) {
    const a4 = project.a4 || 440;
    const bpm = project.bpm || 120;
    const tempoUsPerQuarter = Math.round(60000000 / bpm);

    const tracks = [];

    // --- Track 0: tempo + MPE setup ---
    const t0 = new Track();
    t0.add(0, [0xff, 0x51, 0x03, (tempoUsPerQuarter >> 16) & 0xff, (tempoUsPerQuarter >> 8) & 0xff, tempoUsPerQuarter & 0xff]);
    // track name
    const name = str("GoodJust MPE Export");
    t0.add(0, [0xff, 0x03, name.length, ...name]);
    // MPE configuration: RP-015/RP-018 (MPE Management Message)
    // F0 <len> 7E <device> 0D 01 M NN 00 F7   (M=0 lower zone, NN=15 member ch)
    // ★ len 含结尾 F7
    {
      const body = [0x7e, 0x7f, 0x0d, 0x01, 0x00, 15, 0x00];
      t0.add(0, [0xf0, body.length + 1, ...body, 0xf7]);
    }
    tracks.push(t0);

    // --- 收集所有文件 ---
    const files = [];
    for (const scene of project.scenes) {
      for (const f of Model.sceneFiles(scene)) {
        if (f.notes.length > 0) files.push({ scene, file: f });
      }
    }

    // --- 每个文件一个 track ---
    files.forEach(({ scene, file }) => {
      // ★ MIDI 1.0 只有 16 通道：所有文件共用 lower zone member ch 1-15。
      //   旧版按文件分配「通道族」（globalCh=15*fam → ch16-30/31-45...）
      //   超出 MIDI 1.0 通道数，0xb0|c 在 c>15 时通道位错乱（16→ch0！），
      //   污染全局通道，违反 MPE 规范。
      const members = Array.from({ length: 15 }, (_, i) => 1 + i);

      const tr = new Track();
      // ★ ASCII track 名（中文会乱码）
      const tname = str(`s${scene.id}/${Model.asciiFileName(file)}`);
      tr.add(0, [0xff, 0x03, tname.length, ...tname]);

      // RPN 0 (pitch bend range ±2)：★ MPE 规范只发 member channels，不碰全局 ch
      for (const c of members) {
        tr.add(0, [0xb0 | c, 101, 0]);
        tr.add(0, [0xb0 | c, 100, 0]);
        tr.add(0, [0xb0 | c, 6, PB_RANGE]);
        tr.add(0, [0xb0 | c, 38, 0]);
      }

      // ★ 通道分配：优先空闲最久的通道（轮铺 ch1-15 + 避开 release 尾音）
      const chOf = assignChannels(file.notes, members);
      const notes = file.notes.slice().sort((a, b) => a.start - b.start);
      for (const n of notes) {
        const ch = chOf.get(n);
        const startTick = Math.round(n.start * PPQ);
        const endTick = Math.max(startTick + 1, Math.round((n.start + n.dur) * PPQ));
        const { note, bend } = centsToNoteBend(n.cents, a4);

        // channel pressure (MPE: per-note expression) — 简单发一个
        tr.add(startTick, [0xd0 | ch, Math.round((n.vel / 127) * 127)]);

        // pitchbend (LSB, MSB)
        tr.add(startTick, [0xe0 | ch, bend & 0x7f, (bend >> 7) & 0x7f]);
        tr.add(startTick, [0x90 | ch, note, Math.max(1, Math.min(127, Math.round(n.vel)))]);
        tr.add(endTick, [0x80 | ch, note, 0x40]);
      }
      tracks.push(tr);
    });

    // --- 组装 SMF1 ---
    const header = [...str("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)];
    const bytes = [...header];
    for (const t of tracks) bytes.push(...t.build());

    return new Uint8Array(bytes).buffer;
  }

  /** 触发下载 */
  function download(project, filename) {
    const buf = exportProject(project);
    const blob = new Blob([buf], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.getElementById("dl-anchor");
    a.href = url;
    a.download = filename || "goodjust.mid";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { exportProject, exportFile, download, centsToNoteBend };
})();

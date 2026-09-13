/* ============================================================
 * GoodJust — audio.js
 * Web Audio 播放引擎：lookahead 调度器 + 简单加法合成器。
 * 播放当前 Scene 的所有文件（和声/旋律），音色按文件类型区分。
 * ============================================================ */
"use strict";

const AudioEngine = (() => {

  let ctx = null;
  let master = null;
  let playing = false;
  let startCtxTime = 0;   // ctx.currentTime at play start
  let startBeat = 0;
  let timerId = null;
  const LOOKAHEAD = 0.12;  // s
  const INTERVAL = 25;     // ms

  let getEvents = null;    // () => [{timeBeat, durBeat, cents, vel, kind}]
  let getBpm = null;       // () => number
  let getLoop = null;      // () => {start, end} | null
  let onEnd = null;
  // ★ 已调度标记：collectEvents() 每次返回全新对象，标记打在对象上即丢
  //   → lookahead 窗口内同一音符重复发声 4-5 次。改用独立 Set（按 start+cents+vel 键）
  let scheduledKeys = new Set();
  const evKey = (e) => `${e.timeBeat}|${e.durBeat}|${e.cents}|${e.vel}|${e.kind}`;
  const resetScheduled = () => { scheduledKeys = new Set(); };

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  function beatToSec(beat, bpm) { return beat * 60 / bpm; }

  /** 简单合成器：三角波 + 衰减包络；和声用三角，旋律用锯齿+低通 */
  function playNote(when, durSec, freq, vel, kind) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    let amp = (vel / 127) * 0.22;
    let head = osc; // 信号链头

    if (kind === "bass") {
      osc.type = "sine";
      amp *= 1.2;
    } else if (kind === "harmony") {
      osc.type = "triangle";
      amp *= 0.7;
    } else {
      osc.type = "sawtooth";
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = Math.min(8000, freq * 6);
      osc.connect(lp);
      head = lp;
    }
    osc.frequency.value = freq;

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.012);
    g.gain.setTargetAtTime(amp * 0.7, when + 0.012, 0.08);
    g.gain.setTargetAtTime(0, when + durSec * 0.9, 0.05);
    head.connect(g);
    g.connect(master);
    osc.start(when);
    osc.stop(when + durSec + 0.3);
  }

  function scheduler() {
    if (!playing) return;
    const bpm = getBpm();
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const loop = getLoop ? getLoop() : null;

    let curBeat = startBeat + (now - startCtxTime) * bpm / 60;
    // 循环：越过选区末尾 → 重新锚定时间原点，位置跳回选区内
    // （注意：不能同时加 startBeat 和 startCtxTime，否则 currentBeat 自我抵消不回卷）
    if (loop && curBeat > loop.end) {
      const span = Math.max(0.001, loop.end - loop.start);
      const overshoot = curBeat - loop.end;
      const wrapped = loop.start + (overshoot % span);
      startBeat = wrapped;
      startCtxTime = now;
      curBeat = wrapped;
      // 回卷后未调度的事件重新可调度
      resetScheduled();
    }
    const horizonBeat = startBeat + (horizon - startCtxTime) * bpm / 60;

    const events = getEvents();
    // loop 选区播放：只在选区内的音符发声
    const inLoop = (tBeat) => !loop || (tBeat >= loop.start && tBeat < loop.end);
    for (const e of events) {
      const k = evKey(e);
      if (scheduledKeys.has(k)) continue;
      const tBeat = e.timeBeat;
      if (!inLoop(tBeat)) continue;
      if (tBeat >= curBeat && tBeat < horizonBeat) {
        const when = startCtxTime + beatToSec(tBeat - startBeat, bpm);
        const durSec = Math.max(0.05, beatToSec(e.durBeat, bpm) * 0.95);
        playNote(when, durSec, Tuning.centsToFreq(e.cents, Tuning.getA4()), e.vel, e.kind);
        scheduledKeys.add(k);
      }
    }
    // 结束检测
    const maxBeat = loop ? loop.end : events.reduce((m, e) => Math.max(m, e.timeBeat + e.durBeat), 0);
    if (curBeat > maxBeat + 0.5) stop();
  }

  function play(fromBeat = 0) {
    ensureCtx();
    stopInternal();
    const loop = getLoop ? getLoop() : null;
    // 若在 loop 选区内，从选区起点开始，让播放循环选区
    startBeat = (loop && fromBeat >= loop.start && fromBeat <= loop.end) ? loop.start : fromBeat;
    startCtxTime = ctx.currentTime + 0.05;
    playing = true;
    resetScheduled();
    scheduler();
    timerId = setInterval(scheduler, INTERVAL);
  }

  function stopInternal() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function stop() {
    playing = false;
    stopInternal();
    if (onEnd) onEnd();
  }

  function isPlaying() { return playing; }
  /** 当前播放位置（拍） */
  function currentBeat() {
    if (!playing || !ctx) return startBeat;
    const bpm = getBpm();
    return startBeat + (ctx.currentTime - startCtxTime) * bpm / 60;
  }

  /** solo 变化时：保留当前位置用新事件重排（不改集合，只重排未来） */
  function restartIfPlaying(events) {
    if (!playing) return;
    const from = currentBeat();
    startBeat = from;
    startCtxTime = ctx.currentTime + 0.05;
    resetScheduled();
    stopInternal();
    if (timerId) { clearInterval(timerId); timerId = null; }
    scheduler();
    timerId = setInterval(scheduler, INTERVAL);
  }

  /** 播放中跳转到指定拍（保留播放状态） */
  function seekTo(beat) {
    if (!playing) return;
    const loop = getLoop ? getLoop() : null;
    startBeat = Math.max(0, beat);
    startCtxTime = ctx.currentTime + 0.05;
    resetScheduled();
    stopInternal();
    scheduler();
    timerId = setInterval(scheduler, INTERVAL);
  }

  function init(opts) {
    getEvents = opts.getEvents;
    getBpm = opts.getBpm;
    getLoop = opts.getLoop;
    onEnd = opts.onEnd;
  }

  return { init, play, stop, isPlaying, currentBeat, ensureCtx, restartIfPlaying, seekTo };
})();

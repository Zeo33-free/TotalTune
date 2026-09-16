#include "TotalTuneProcessor.h"
#include "TotalTuneEditor.h"

#include <cmath>

// =============================================================================
// 构造 / 析构
// =============================================================================
TotalTuneAudioProcessor::TotalTuneAudioProcessor()
    : AudioProcessor (BusesProperties()
                        .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "TotalTuneParams", createParameterLayout())
{
}

TotalTuneAudioProcessor::~TotalTuneAudioProcessor()
{
}

juce::AudioProcessorValueTreeState::ParameterLayout
TotalTuneAudioProcessor::createParameterLayout()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    // 内置小合成器：音量 + 波形（UI 面板直接控制）
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { idSynthVol, 1 },
        "Synth Volume",
        juce::NormalisableRange<float> (0.0f, 1.0f, 0.0f, 1.0f),
        0.8f));

    juce::StringArray waveNames { "Sine", "Triangle", "Saw", "Square" };
    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { idSynthWave, 1 },
        "Synth Waveform",
        waveNames,
        0));

    return layout;
}

// =============================================================================
// UI → 引擎：工程数据（旧协议，保留兼容；新代码走 setUiStateFromUI）
// =============================================================================
void TotalTuneAudioProcessor::setProjectFromUI (const juce::String& json)
{
    setProjectFromUiState (json);
}

void TotalTuneAudioProcessor::setUiStateFromUI (const juce::String& json)
{
    // 内容变化时：旧状态入撤销栈（消息线程专用，无需加锁）
    if (json != uiStateJson && uiStateJson.isNotEmpty())
    {
        undoStack.push_back (uiStateJson);
        if (undoStack.size() > kMaxUndo)
            undoStack.erase (undoStack.begin());
        redoStack.clear();
    }

    uiStateJson = json;
    setProjectFromUiState (json);   // 同步喂给播放引擎
}

juce::String TotalTuneAudioProcessor::undoFromUI()
{
    if (undoStack.empty())
        return {};

    redoStack.push_back (uiStateJson);
    uiStateJson = undoStack.back();
    undoStack.pop_back();
    setProjectFromUiState (uiStateJson);
    return uiStateJson;
}

juce::String TotalTuneAudioProcessor::redoFromUI()
{
    if (redoStack.empty())
        return {};

    undoStack.push_back (uiStateJson);
    uiStateJson = redoStack.back();
    redoStack.pop_back();
    setProjectFromUiState (uiStateJson);
    return uiStateJson;
}

juce::String TotalTuneAudioProcessor::getUiState()
{
    return uiStateJson;
}

/** 解析 UI 持久化格式（Serialize.save 输出 + ui 字段）→ 播放事件表 */
void TotalTuneAudioProcessor::setProjectFromUiState (const juce::String& json)
{
    const juce::ScopedLock sl (projectLock);

    auto parsed = juce::JSON::parse (json);
    auto* obj = parsed.getDynamicObject();
    if (obj == nullptr)
        return;

    projectBpm = (double) obj->getProperty ("bpm");
    if (projectBpm < 20.0 || projectBpm > 300.0) projectBpm = 120.0;
    projectA4 = (double) obj->getProperty ("a4");
    if (projectA4 < 380.0 || projectA4 > 500.0) projectA4 = 440.0;

    activeSceneName = obj->getProperty ("activeScene").toString();

    sceneTable.clear();
    activeEvents.clear();
    projectEndBeat = 0.0;

    auto* scenesArr = obj->getProperty ("scenes").getArray();
    if (scenesArr == nullptr)
    {
        scheduled.clear();
        return;
    }

    for (auto& sceneVar : *scenesArr)
    {
        auto* sceneObj = sceneVar.getDynamicObject();
        if (sceneObj == nullptr)
            continue;

        SceneEvents se;
        se.sceneName = sceneObj->getProperty ("name").toString();

        // 文件数组：[{name, type, audible, notes:[{start,dur,cents,vel}]}]
        auto* filesArr = sceneObj->getProperty ("files").getArray();
        if (filesArr != nullptr)
        {
            for (auto& fileVar : *filesArr)
            {
                auto* fileObj = fileVar.getDynamicObject();
                if (fileObj == nullptr)
                    continue;

                const bool audible = (bool) (int) fileObj->getProperty ("audible");
                const float fileSynthVol = (float) (double) fileObj->getProperty ("synthVol");
                auto* notesArr = fileObj->getProperty ("notes").getArray();
                if (notesArr == nullptr)
                    continue;

                for (auto& noteVar : *notesArr)
                {
                    auto* n = noteVar.getDynamicObject();
                    if (n == nullptr)
                        continue;

                    TTNoteEvent ev;
                    ev.startBeat = (double) n->getProperty ("start");
                    ev.durBeat   = juce::jmax (0.05, (double) n->getProperty ("dur"));
                    ev.cents     = (double) n->getProperty ("cents");
                    ev.vel       = (int) n->getProperty ("vel");
                    ev.synthVol  = juce::jlimit (0.0f, 1.0f, fileSynthVol);

                    se.events.push_back (ev);
                    if (audible && se.sceneName == activeSceneName)
                        activeEvents.push_back (ev);
                }
            }
        }

        sceneTable.push_back (std::move (se));
    }

    // 按 start 排序（调度器要求）
    std::sort (activeEvents.begin(), activeEvents.end(),
               [] (const TTNoteEvent& a, const TTNoteEvent& b) { return a.startBeat < b.startBeat; });

    // 工程末尾（拍）：无 loop 播完自动停
    projectEndBeat = 0.0;
    for (const auto& ev : activeEvents)
        projectEndBeat = juce::jmax (projectEndBeat, ev.startBeat + ev.durBeat);

    scheduled.assign (activeEvents.size(), false);
}

void TotalTuneAudioProcessor::setPlayingFromUI (bool shouldPlay)
{
    uiWantsPlay.store (shouldPlay, std::memory_order_relaxed);
    playing.store (shouldPlay, std::memory_order_relaxed);
    disarmed.store (! shouldPlay, std::memory_order_relaxed);   // UI 停止 → 引擎静音（即使宿主在播）

    if (! shouldPlay)
    {
        // ★ 暂停/停止：给所有正在响的音符发 MIDI note off
        // （在下一个 processBlock 里执行，保证在音频线程上下文）
        // 这里只清内部状态
        internalClockBeat = playheadBeat.load (std::memory_order_relaxed);
    }
    else
    {
        // 重新开始：从当前播放头位置起播（已结束的事件不回放；
        // 播放头落在音符中间的持续音由 triggerSustainingNotes 立即触发）
        const double b = playheadBeat.load (std::memory_order_relaxed);
        const juce::ScopedLock sl (projectLock);
        markScheduledUpTo (b);
    }
}

void TotalTuneAudioProcessor::setLoopFromUI (double startBeat, double endBeat, bool has)
{
    hasLoop.store (has, std::memory_order_relaxed);
    loopStart.store (startBeat, std::memory_order_relaxed);
    loopEnd.store (endBeat, std::memory_order_relaxed);
}

void TotalTuneAudioProcessor::seekTo (double beat)
{
    const double b = juce::jmax (0.0, beat);
    playheadBeat.store (b, std::memory_order_relaxed);
    internalClockBeat = b;   // 内部时钟重新锚定
    pendingFlush.store (true, std::memory_order_relaxed);   // 下一块先全 note off

    // 重新调度：已结束的事件标记为已发（不回放过去）；
    // 落在音符中间的位置由 triggerSustainingNotes 立即触发持续音
    const juce::ScopedLock sl (projectLock);
    markScheduledUpTo (b);
}

// =============================================================================
// processBlock：调度音符 → MPE MIDI 输出 + 内置合成器
// =============================================================================
void TotalTuneAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();
    midi.clear();

    const int numSamples = buffer.getNumSamples();
    const double sr = getSampleRate();

    // ---- 宿主信息：playhead + bpm ----
    double hostBeat = -1.0;
    double bpm = projectBpm;
    bool hostPlaying = false;

    if (auto* ph = getPlayHead())
    {
        juce::AudioPlayHead::CurrentPositionInfo pos;
        if (ph->getCurrentPosition (pos))
        {
            hostPlaying = pos.isPlaying;
            if (pos.bpm > 0.0 && pos.bpm < 999.0)
                bpm = pos.bpm;   // ★ BPM 始终跟随宿主
            if (pos.ppqPosition >= 0.0)
                hostBeat = pos.ppqPosition;
        }
    }

    hostPlayingFlag.store (hostPlaying, std::memory_order_relaxed);   // 仅供 UI 显示

    // bpm 变化时通知 UI（编辑器轮询 getPlayheadBeat / bpm）
    lastBpm = bpm;

    // ---- 引擎是否发声 ----
    // ★ 只由 UI 播放按钮控制，不跟宿主 transport 联动（用户要求）
    const bool enginePlaying = playing.load (std::memory_order_relaxed);

    // ---- 播放位置 ----
    // ★ 不跟宿主联动：一律用内部时钟推进（宿主 playhead 仅作 UI 显示参考）
    if (enginePlaying)
    {
        const double beatsPerSample = bpm / 60.0 / sr;
        internalClockBeat += beatsPerSample * numSamples;
        playheadBeat.store (internalClockBeat, std::memory_order_relaxed);
    }
    else
    {
        // 没播：保持位置（seekTo 已更新 playheadBeat，这里不动）
    }

    const double nowBeat = playheadBeat.load (std::memory_order_relaxed);

    // ---- 播放状态沿检测（替代 function-static，多实例安全）----
    if (! enginePlaying && engineWasPlaying)
    {
        // ★ 暂停/停止：给所有正在响的音符发 MIDI note off
        for (int i = 0; i < 15; ++i)
        {
            if (voiceSlots[i].active)
            {
                const int ch = i + 1;
                midi.addEvent (juce::MidiMessage::noteOff (ch, voiceSlots[i].note, (juce::uint8) 0), 0);
                voiceSlots[i].active = false;
            }
        }
        synth.reset();
    }
    engineWasPlaying = enginePlaying;

    // ---- seek / 位置跳变后第一块：先清掉所有残留音符 ----
    const bool jumped = std::abs (nowBeat - lastProcessBeat) > 0.001
                        && lastProcessBeat >= 0.0
                        && std::abs (nowBeat - lastProcessBeat) > (numSamples / sr) * bpm / 60.0 * 2.0;
    if (pendingFlush.exchange (false) || (enginePlaying && jumped))
    {
        // ★ MPE 规范：只用 member ch 1-15，不碰 ch 0（全局通道）
        for (int ch = 1; ch <= 15; ++ch)
            midi.addEvent (juce::MidiMessage::allNotesOff (ch), 0);
        for (auto& vs : voiceSlots) vs.active = false;
        synth.reset();

        // 重新调度：已结束的事件标记为已发（不回放过去）；
        // 落在音符中间的位置立即触发持续音
        const juce::ScopedLock sl (projectLock);
        markScheduledUpTo (nowBeat);
        if (enginePlaying)
            triggerSustainingNotes (nowBeat, midi);
    }
    lastProcessBeat = nowBeat;

    // ---- 开始播放沿：重置调度标记（从头/从 seek 点播）----
    if (enginePlaying && ! engineWasPlayingPrev)
    {
        const juce::ScopedLock sl (projectLock);
        markScheduledUpTo (nowBeat);
        triggerSustainingNotes (nowBeat, midi);   // 播放头在音符中间 → 立即触发
    }
    engineWasPlayingPrev = enginePlaying;

    // ---- 音符调度（播放中）----
    if (enginePlaying)
    {
        const juce::ScopedLock sl (projectLock);

        const double loopS = loopStart.load (std::memory_order_relaxed);
        const double loopE = loopEnd.load (std::memory_order_relaxed);
        const bool inLoopMode = hasLoop.load (std::memory_order_relaxed);

        // loop 回绕检测：nowBeat 跳出选区 → 回到选区内
        double effectiveBeat = nowBeat;
        if (inLoopMode && loopE > loopS)
        {
            if (nowBeat >= loopE || nowBeat < loopS - 0.001)
            {
                const double span = loopE - loopS;
                const double wrapped = loopS + std::fmod (juce::jmax (0.0, nowBeat - loopS), span);
                effectiveBeat = wrapped;
                playheadBeat.store (wrapped, std::memory_order_relaxed);
                internalClockBeat = wrapped;   // ★ 同步内部时钟，否则 Standalone 每块都重复回绕

                // ★ 每次回绕：全 note off 清掉上一轮残留 + 重新加载选区内所有音符
                // ★ MPE 规范：只用 member ch 1-15，不碰 ch 0（全局通道）
                for (int ch = 1; ch <= 15; ++ch)
                    midi.addEvent (juce::MidiMessage::allNotesOff (ch), 0);
                for (auto& vs : voiceSlots) vs.active = false;
                synth.reset();

                for (size_t idx = 0; idx < activeEvents.size(); ++idx)
                {
                    const auto& ev = activeEvents[idx];
                    if (ev.startBeat >= loopS && ev.startBeat < loopE)
                        scheduled[idx] = false;   // 选区内全部重新武装（正常宿主行为）
                }
                markScheduledUpTo (wrapped);              // 回绕点之前的不回放
                triggerSustainingNotes (wrapped, midi);   // 跨回绕点的长音立即触发
            }
        }
        const double horizonBeat = effectiveBeat + (numSamples / sr) * bpm / 60.0;

        for (size_t idx = 0; idx < activeEvents.size(); ++idx)
        {
            if (scheduled[idx])
                continue;

            const auto& ev = activeEvents[idx];

            // loop 模式：只调度选区内的事件
            if (inLoopMode && (ev.startBeat < loopS || ev.startBeat >= loopE))
                continue;

            if (ev.startBeat >= effectiveBeat && ev.startBeat < horizonBeat)
            {
                // 事件落在本块内：算出块内采样偏移
                const double offsetSec = (ev.startBeat - effectiveBeat) * 60.0 / bpm;
                const int samplePos = juce::jlimit (0, numSamples - 1, (int) (offsetSec * sr));

                fireNoteEvent (ev, midi, samplePos, effectiveBeat);
                scheduled[idx] = true;
            }
        }

        // ---- 到期的 note off（MIDI + 内置合成器同步）----
        for (int i = 0; i < 15; ++i)
        {
            auto& vs = voiceSlots[i];
            if (vs.active && vs.endBeat <= effectiveBeat)
            {
                const int ch = i + 1;
                midi.addEvent (juce::MidiMessage::noteOff (ch, vs.note, (juce::uint8) 0), 0);
                vs.active = false;
                synth.noteOffVoice (vs.synthVoice);   // ★ 按声部精确释放（同音紧挨的音符不会被误杀）
                vs.synthVoice = -1;
            }
        }

        // ---- 无 loop：播完自动停（播放头不跑飞）----
        if (! inLoopMode && projectEndBeat > 0.0 && effectiveBeat > projectEndBeat + 0.5)
        {
            playing.store (false, std::memory_order_relaxed);
            uiWantsPlay.store (false, std::memory_order_relaxed);
            playheadBeat.store (projectEndBeat, std::memory_order_relaxed);
            internalClockBeat = projectEndBeat;
        }
    }

    // ---- 内置合成器发声（Standalone 试听 / 无下游乐器时也能听到）----
    if (enginePlaying)
        synth.render (buffer, numSamples);

    // ---- 参数 → 合成器 ----
    synth.setVolume (apvts.getRawParameterValue (idSynthVol)->load());
    synth.setWaveform (apvts.getRawParameterValue (idSynthWave)->load());
}

// MPE 通道池：找空闲 member channel
int TotalTuneAudioProcessor::findFreeSlot()
{
    for (int i = 0; i < 15; ++i)
        if (! voiceSlots[i].active)
            return i;
    return -1;
}

// 偷轨道：找「结束最早」的占用者
int TotalTuneAudioProcessor::findSlotToSteal (double nowBeat)
{
    int best = -1;
    double bestEnd = 1e18;
    for (int i = 0; i < 15; ++i)
    {
        if (! voiceSlots[i].active)
            continue;
        // 优先偷已经该结束但还没发的（长音）
        const double remaining = voiceSlots[i].endBeat - nowBeat;
        if (remaining < bestEnd)
        {
            bestEnd = remaining;
            best = i;
        }
    }
    return best;
}

// 已结束的事件标记为已发（不回放）；仍在持续的留给 triggerSustainingNotes
// ★ 只标记、绝不重置：起播沿/flush 会连续多次调用，若用赋值会把
//   triggerSustainingNotes 刚标记过的音符重置回未发 → 同一音发两遍
void TotalTuneAudioProcessor::markScheduledUpTo (double beat)
{
    for (size_t idx = 0; idx < activeEvents.size(); ++idx)
    {
        const auto& ev = activeEvents[idx];
        if ((ev.startBeat + ev.durBeat) <= beat)
            scheduled[idx] = true;
    }
}

// 触发一个音符：分配 MPE 通道 → RPN/pitchbend/pressure/noteOn → 内置合成器
void TotalTuneAudioProcessor::fireNoteEvent (const TTNoteEvent& ev, juce::MidiBuffer& midi,
                                             int samplePos, double nowBeat)
{
    // cents → midi note + pitchbend（±2 半音，14bit）
    const double midiFloat = ev.cents / 100.0 + 69.0;
    int note = (int) std::lround (midiFloat);
    note = juce::jlimit (0, 127, note);
    const double semis = midiFloat - note;
    int bend = (int) std::lround (8192.0 + (semis / 2.0) * 8192.0);
    bend = juce::jlimit (0, 16383, bend);

    // ---- 分配 MPE member channel ----
    int slot = findFreeSlot();
    if (slot < 0)
    {
        // ★ 复音超 15：偷「结束最早」的轨道
        slot = findSlotToSteal (nowBeat);
        if (slot >= 0)
        {
            const int ch = slot + 1;
            midi.addEvent (juce::MidiMessage::noteOff (ch, voiceSlots[slot].note, (juce::uint8) 0), samplePos);
            synth.noteOffVoice (voiceSlots[slot].synthVoice);   // 合成器同步释放（按声部，不误杀同音其他声部）
            voiceSlots[slot].synthVoice = -1;
            polyStolenFlag.store (true, std::memory_order_relaxed);   // UI 标题栏警告
        }
    }

    if (slot < 0)
        return;

    const int ch = slot + 1;
    auto& vs = voiceSlots[slot];

    vs.active  = true;
    vs.note    = note;
    vs.endBeat = ev.startBeat + ev.durBeat;
    vs.bend14  = bend;

    // RPN 0：pitchbend range ±2（每个 channel 一次即可，但保险起见每次发）
    midi.addEvent (juce::MidiMessage::controllerEvent (ch, 101, 0), samplePos);
    midi.addEvent (juce::MidiMessage::controllerEvent (ch, 100, 0), samplePos);
    midi.addEvent (juce::MidiMessage::controllerEvent (ch, 6, 2), samplePos);
    midi.addEvent (juce::MidiMessage::controllerEvent (ch, 38, 0), samplePos);

    // pitchbend（微音差）
    midi.addEvent (juce::MidiMessage::pitchWheel (ch, bend), samplePos);

    // channel pressure（MPE per-note 表情）
    midi.addEvent (juce::MidiMessage::channelPressureChange (ch, juce::jlimit (1, 127, ev.vel)), samplePos);

    // note on
    midi.addEvent (juce::MidiMessage::noteOn (ch, note, (juce::uint8) juce::jlimit (1, 127, ev.vel)), samplePos);

    // 内置合成器同步发声（★ 传实际频率，JI 微音差也能正确发声，不能只给 12-TET 音号）
    // ★ 文件混音音量只缩放合成器；MIDI 输出的 noteOn/pressure 仍用原始 vel
    const double freqHz = projectA4 * std::pow (2.0, ev.cents / 1200.0);
    vs.synthVoice = synth.noteOn (note, ev.vel / 127.0f * juce::jlimit (0.0f, 1.0f, ev.synthVol), freqHz);
}

// 播放头落在音符中间（起播/seek/loop 回绕）：立即触发仍在持续的音符。
// 不回放已过去的部分，noteOff 仍在原 endBeat 到期。
void TotalTuneAudioProcessor::triggerSustainingNotes (double nowBeat, juce::MidiBuffer& midi)
{
    const bool   inLoop = hasLoop.load (std::memory_order_relaxed);
    const double loopS  = loopStart.load (std::memory_order_relaxed);
    const double loopE  = loopEnd.load (std::memory_order_relaxed);

    for (size_t idx = 0; idx < activeEvents.size(); ++idx)
    {
        if (scheduled[idx])
            continue;

        const auto& ev = activeEvents[idx];

        // loop 模式：只触发选区内的事件（与调度器一致）
        if (inLoop && (ev.startBeat < loopS || ev.startBeat >= loopE))
            continue;

        // 仍在持续：start < now < end（★ 严格小于：start == now 的音符
        // 由下面的调度器负责，两边都发会双重触发）
        if (ev.startBeat < nowBeat && nowBeat < ev.startBeat + ev.durBeat)
        {
            fireNoteEvent (ev, midi, 0, nowBeat);
            scheduled[idx] = true;
        }
    }
}

// =============================================================================
// temp 文件导出（消息线程调用，UI 请求）
// =============================================================================
void TotalTuneAudioProcessor::writeTempFiles()
{
    // 实现在 Editor 侧（有 temp 目录句柄），这里只做标记
    // 实际上 UI 直接调 ttWriteFile(path, bytes) 原生函数，不需要经过这里
}

// =============================================================================
// SMF 导出（拖拽 / temp 写出）
// =============================================================================
namespace smf
{
    static void writeVarlen (juce::MemoryOutputStream& out, int value)
    {
        juce::uint32 v = (juce::uint32) value;
        juce::uint8 buf[5];
        int n = 0;
        buf[n++] = (juce::uint8) (v & 0x7f);
        v >>= 7;
        while (v > 0) { buf[n++] = (juce::uint8) ((v & 0x7f) | 0x80); v >>= 7; }
        for (int i = n - 1; i >= 0; --i)
            out.writeByte ((char) buf[i]);
    }

    struct Track
    {
        struct Ev { int tick; std::vector<juce::uint8> bytes; };
        std::vector<Ev> events;

        void add (int tick, std::vector<juce::uint8> bytes) { events.push_back ({ tick, std::move (bytes) }); }

        void build (juce::MemoryOutputStream& out)
        {
            std::sort (events.begin(), events.end(),
                       [] (const Ev& a, const Ev& b) { return a.tick < b.tick; });

            juce::MemoryOutputStream data;
            int last = 0;
            for (auto& e : events)
            {
                writeVarlen (data, e.tick - last);
                last = e.tick;
                for (auto b : e.bytes) data.writeByte ((char) b);
            }
            writeVarlen (data, 0);
            data.writeByte ((char) 0xff); data.writeByte ((char) 0x2f); data.writeByte ((char) 0x00);

            out.write ("MTrk", 4);
            out.writeIntBigEndian ((int) data.getDataSize());
            out.write (data.getData(), (size_t) data.getDataSize());
        }

        void buildTo (juce::MemoryBlock& mb)
        {
            juce::MemoryOutputStream out (mb, false);
            std::sort (events.begin(), events.end(),
                       [] (const Ev& a, const Ev& b) { return a.tick < b.tick; });

            juce::MemoryOutputStream data;
            int last = 0;
            for (auto& e : events)
            {
                writeVarlen (data, e.tick - last);
                last = e.tick;
                for (auto b : e.bytes) data.writeByte ((char) b);
            }
            writeVarlen (data, 0);
            data.writeByte ((char) 0xff); data.writeByte ((char) 0x2f); data.writeByte ((char) 0x00);

            out.write ("MTrk", 4);
            const int len = (int) data.getDataSize();
            out.writeIntBigEndian (len);
            out.write (data.getData(), (size_t) len);
        }
    };

    static std::vector<juce::uint8> strBytes (const juce::String& s)
    {
        const auto raw = s.toRawUTF8();
        return std::vector<juce::uint8> (raw, raw + s.getNumBytesAsUTF8());
    }
}

// 单文件 → SMF0（temp 写出 / 拖拽）
juce::MemoryBlock TotalTuneAudioProcessor::exportFileMidi (const juce::String& sceneName, const juce::String& fileName)
{
    juce::MemoryBlock mb;
    juce::MemoryOutputStream out (mb, false);

    const juce::ScopedLock sl (projectLock);

    // 找到目标文件的事件
    // （UI 传 sceneName + fileName；这里从 sceneTable 找不到精确文件级数据，
    //   所以 UI 侧直接把「该文件的音符数组」打包进 uiStateJson 的一个特殊字段，
    //   或者干脆由 UI 生成 SMF 字节再传给原生写盘 —— 后者更简单，见 Editor）
    juce::ignoreUnused (sceneName, fileName);
    return mb;
}

juce::MemoryBlock TotalTuneAudioProcessor::exportProjectMidi()
{
    juce::MemoryBlock mb;
    return mb;
}

// =============================================================================
// 其余 AudioProcessor 接口
// =============================================================================
void TotalTuneAudioProcessor::prepareToPlay (double sampleRate, int /*samplesPerBlock*/)
{
    synth.prepare (sampleRate);
    internalClockBeat = 0.0;
    lastHostBeat = -1.0;
    hostWasPlaying = false;
    lastProcessBeat = -1.0;
    engineWasPlaying = false;
    engineWasPlayingPrev = false;
}

void TotalTuneAudioProcessor::releaseResources()
{
    synth.reset();
}

#ifndef JucePlugin_PreferredChannelConfigurations
bool TotalTuneAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    // MIDI effect：不需要输入音频；Instrument（synth）：无输入、立体声输出
    if (JucePlugin_IsMidiEffect)
    {
        if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::mono()
            && layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo())
            return false;
        if (layouts.getMainInputChannelSet() != juce::AudioChannelSet::discreteChannels (0)
            && layouts.getMainInputChannelSet() != juce::AudioChannelSet::mono()
            && layouts.getMainInputChannelSet() != juce::AudioChannelSet::stereo())
            return false;
        return true;
    }
    // Instrument：无音频输入，输出 mono/stereo 都接受
    if (layouts.getMainInputChannelSet() != juce::AudioChannelSet::discreteChannels (0))
        return false;
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::mono()
        || layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}
#endif

juce::AudioProcessorEditor* TotalTuneAudioProcessor::createEditor()
{
    return new TotalTuneAudioProcessorEditor (*this);
}

bool TotalTuneAudioProcessor::hasEditor() const { return true; }

const juce::String TotalTuneAudioProcessor::getName() const { return JucePlugin_Name; }

bool TotalTuneAudioProcessor::acceptsMidi() const { return true; }
bool TotalTuneAudioProcessor::producesMidi() const { return true; }
bool TotalTuneAudioProcessor::isMidiEffect() const
{
    // 同一份源码编译两个变体：TotalTune（MIDI effect）与 TotalTuneInst
    // （VST3 Instrument）。JUCE CMake 为每个目标生成 JucePlugin_IsMidiEffect。
    return JucePlugin_IsMidiEffect != 0;
}
double TotalTuneAudioProcessor::getTailLengthSeconds() const { return 0.0; }

int TotalTuneAudioProcessor::getNumPrograms() { return 1; }
int TotalTuneAudioProcessor::getCurrentProgram() { return 0; }
void TotalTuneAudioProcessor::setCurrentProgram (int) {}
const juce::String TotalTuneAudioProcessor::getProgramName (int) { return {}; }
void TotalTuneAudioProcessor::changeProgramName (int, const juce::String&) {}

void TotalTuneAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::MemoryOutputStream mos (destData, false);
    // 保存：完整 UI 工程 JSON（音符/场景/律制/撤销基础）+ 合成器参数
    const juce::ScopedLock sl (projectLock);
    mos.writeString (uiStateJson);
    mos.writeFloat (apvts.getRawParameterValue (idSynthVol)->load());
    mos.writeFloat (apvts.getRawParameterValue (idSynthWave)->load());
}

void TotalTuneAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    juce::MemoryInputStream mis (data, (size_t) sizeInBytes, false);
    const juce::String json = mis.readString();
    const float vol = mis.readFloat();
    const float wave = mis.readFloat();

    if (auto* p = apvts.getParameter (idSynthVol))
        p->setValueNotifyingHost (p->convertTo0to1 (vol));
    if (auto* p = apvts.getParameter (idSynthWave))
        p->setValueNotifyingHost (p->convertTo0to1 (wave));

    // 恢复宿主存档：直接覆盖，不入撤销栈（否则一打开就有「撤销到空工程」）
    uiStateJson = json;
    setProjectFromUiState (json);
}

// =============================================================================
// 插件工厂（JUCE 包装器入口）
// =============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new TotalTuneAudioProcessor();
}

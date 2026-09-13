#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include <array>
#include <atomic>
#include <mutex>
#include <vector>

// =============================================================================
// 诊断日志：写 %TEMP%\TotalTune_webview.log
// =============================================================================
namespace tt
{
    inline void log (const juce::String& message)
    {
        static const juce::File logFile
            = juce::File::getSpecialLocation (juce::File::tempDirectory)
                  .getChildFile ("TotalTune_webview.log");

        logFile.appendText (juce::Time::getCurrentTime().toString (false, true)
                                + "  " + message + juce::newLine);
    }
}

// =============================================================================
// SimpleSynth —— 界面「小合成器」的发声引擎（JUCE 原生，不用 Web Audio）
//
// 最简单的减法合成：1 个振荡器（正弦/三角/锯齿/方波）+ ADSR + 音量。
// 由 UI 面板直接控制（音量/波形），音符来自编辑器播放引擎输出的 MIDI。
// =============================================================================
class SimpleSynth
{
public:
    enum Waveform { sine = 0, triangle, saw, square, numWaveforms };

    void prepare (double sampleRate)
    {
        sr = sampleRate;
        // 包络系数按实际采样率重算（构造时的默认值是 48k 硬编码）
        attackCoeff  = 1.0f - std::exp (-1.0f / (0.005f * (float) sampleRate));
        decayCoeff   = 1.0f - std::exp (-1.0f / (0.050f * (float) sampleRate));
        releaseCoeff = 1.0f - std::exp (-1.0f / (0.080f * (float) sampleRate));
        adsr.setSampleRate (sampleRate);
        reset();
    }

    void reset()
    {
        for (auto& v : voiceActive) v = false;
    }

    void setVolume (float linear) noexcept { gain.store (linear, std::memory_order_relaxed); }
    void setWaveform (int w) noexcept { wave.store (w, std::memory_order_relaxed); }

    // 播放引擎 → 合成器：直接喂音符（MIDI 语义，note on/off）
    // ★ freqHz 传实际频率（含 JI 微音差），不能只给 12-TET 音号
    // ★ 返回声部槽位：释放按槽位精确进行，同音高多个声部互不影响
    int noteOn (int midiNote, float velocity, double freqHz)
    {
        const juce::ScopedLock sl (lock);
        // 找空闲声部；没有就抢最老的
        int slot = -1;
        for (int i = 0; i < kMaxVoices; ++i)
            if (! voiceActive[i]) { slot = i; break; }
        if (slot < 0)
        {
            slot = oldestVoice;
            oldestVoice = (oldestVoice + 1) % kMaxVoices;
        }
        auto& v = voices[(size_t) slot];
        v.note   = midiNote;
        v.freq   = freqHz;
        v.vel    = velocity;
        v.phase  = 0.0;
        voiceActive[(size_t) slot] = true;
        v.env = 0.0f;
        v.state = 0; // attack
        return slot;
    }

    // 按槽位精确释放一个声部（旧版按音号关掉所有同音声部 →
    // [0,2][2,4] 紧挨的同音音符，第二个一响就被第一个的 noteOff 误杀）
    void noteOffVoice (int slot)
    {
        const juce::ScopedLock sl (lock);
        if (slot < 0 || slot >= kMaxVoices)
            return;
        if (voiceActive[(size_t) slot])
            voices[(size_t) slot].state = 3; // release
    }

    void render (juce::AudioBuffer<float>& buffer, int numSamples)
    {
        const float g = gain.load (std::memory_order_relaxed);
        const int   w = wave.load (std::memory_order_relaxed);

        const juce::ScopedLock sl (lock);
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            auto* out = buffer.getWritePointer (ch);
            for (int i = 0; i < numSamples; ++i)
                out[i] = 0.0f;
        }

        for (int vi = 0; vi < kMaxVoices; ++vi)
        {
            if (! voiceActive[(size_t) vi])
                continue;

            auto& v = voices[(size_t) vi];
            const double inc = v.freq / sr;

            for (int i = 0; i < numSamples; ++i)
            {
                // 包络（简化 ADSR：attack 5ms / decay 50ms / sustain 0.7 / release 80ms）
                float target = 0.0f, coeff = 0.0f;
                switch (v.state)
                {
                    case 0: target = 1.0f; coeff = attackCoeff;  if (v.env >= 0.999f) { v.state = 1; } break;
                    case 1: target = 0.7f; coeff = decayCoeff;   break;
                    case 2: target = 0.7f; coeff = 0.0f;         break;
                    default: target = 0.0f; coeff = releaseCoeff;
                        if (v.env < 0.0005f) { voiceActive[(size_t) vi] = false; }
                        break;
                }
                v.env += (target - v.env) * coeff;

                const float s = oscSample (w, v.phase);
                const float amp = v.env * v.vel * 0.25f * g;

                for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
                    buffer.getWritePointer (ch)[i] += s * amp;

                v.phase += inc;
                if (v.phase >= 1.0) v.phase -= 1.0;
            }
        }
    }

    static constexpr int kMaxVoices = 16;

private:
    static float oscSample (int w, double phase) noexcept
    {
        switch (w)
        {
            case sine:     return (float) std::sin (phase * juce::MathConstants<double>::twoPi);
            case triangle: return (float) (4.0 * std::abs (phase - 0.5) - 1.0);
            case saw:      return (float) (2.0 * phase - 1.0);
            case square:   return phase < 0.5 ? 1.0f : -1.0f;
            default:       return 0.0f;
        }
    }

    struct Voice
    {
        double phase = 0.0;
        double freq  = 440.0;
        int    note  = -1;   // 触发时的 MIDI 音号（noteOff 匹配用）
        float  vel   = 1.0f;
        float  env   = 0.0f;
        int    state = 3; // 0 attack 1 decay 2 sustain 3 release
    };

    juce::ADSR adsr;   // 保留（未来换完整 ADSR）
    Voice voices[kMaxVoices];
    bool  voiceActive[kMaxVoices] {};
    int   oldestVoice = 0;

    double sr = 48000.0;
    float  attackCoeff  = 1.0f - std::exp (-1.0f / (0.005f * 48000.0f));
    float  decayCoeff   = 1.0f - std::exp (-1.0f / (0.050f * 48000.0f));
    float  releaseCoeff = 1.0f - std::exp (-1.0f / (0.080f * 48000.0f));

    std::atomic<float> gain { 0.8f };
    std::atomic<int>   wave { sine };

    juce::CriticalSection lock;
};

// =============================================================================
// 播放引擎事件（UI → 音频线程的音符队列元素）
// =============================================================================
struct TTNoteEvent
{
    double startBeat = 0.0;   // 起始（拍）
    double durBeat   = 1.0;   // 时值（拍）
    double cents     = 0.0;   // 音高（相对 A4 的 cents）
    int    vel       = 100;
};

// =============================================================================
// TotalTune —— 高限纯律 MPE MIDI 编辑器
//
// 数据流：
//   UI(WebView) --ttSetProject--> 消息线程缓存 --swap--> 音频线程快照
//   音频线程：按宿主 playhead 位置调度音符 → MPE MIDI 发给宿主
//           （同时喂给内置 SimpleSynth，供 Standalone/无下游乐器时试听）
//
// MPE 通道分配（lower zone，member ch 1..15）：
//   复音 ≤ 15：一个音符占一个 member channel，直到 note off 释放
//   复音 > 15：偷走「结束最早」的占用轨道的音符（先发 note off 再发新音符），
//             并置 polyStolen 标志 → UI 标题栏警告
// =============================================================================
class TotalTuneAudioProcessor : public juce::AudioProcessor
{
public:
    TotalTuneAudioProcessor();
    ~TotalTuneAudioProcessor() override;

    // --- 参数 id ---
    static constexpr const char* idSynthVol  = "synthVol";
    static constexpr const char* idSynthWave = "synthWave";

    juce::AudioProcessorValueTreeState apvts;
    SimpleSynth synth;   // 内置小合成器（UI 可调音量/波形）

    // --- UI → 引擎 ---
    /** UI 推送整包工程数据（JSON 字符串），消息线程调用 */
    void setProjectFromUI (const juce::String& json);
    /** UI 请求播放/停止（播放位置由宿主 playhead 决定） */
    void setPlayingFromUI (bool shouldPlay);
    /** UI 设置 loop 选区（拍），空字符串 = 清除 */
    void setLoopFromUI (double startBeat, double endBeat, bool hasLoop);
    /** UI 定位播放头（拍）——拖标尺 / 播放前定位 */
    void seekTo (double beat);
    /** UI 持久化状态（完整工程 JSON + ui 附加字段）；同时喂给播放引擎，
     *  内容变化时自动把旧状态压入撤销栈 */
    void setUiStateFromUI (const juce::String& json);
    /** 撤销/重做：返回要恢复的 JSON（空 = 无可撤销/重做） */
    juce::String undoFromUI();
    juce::String redoFromUI();
    /** 取回持久化状态（编辑器打开时页面拉取恢复） */
    juce::String getUiState();
    /** UI 请求把当前工程写成 temp/<Scene>/<文件>.mid（消息线程调用） */
    void writeTempFiles();
    /** UI 请求拖拽导出：返回 SMF 字节（单文件或整工程） */
    juce::MemoryBlock exportFileMidi (const juce::String& sceneName, const juce::String& fileName);
    juce::MemoryBlock exportProjectMidi();

    // --- 引擎 → UI ---
    bool isPlaying() const noexcept { return playing.load (std::memory_order_relaxed); }
    /** 引擎是否发声中：UI 播放 或 宿主 transport 播放中，且未被 UI 停止 */
    bool isEngineActive() const noexcept
    {
        return (playing.load (std::memory_order_relaxed)
                || hostPlayingFlag.load (std::memory_order_relaxed))
               && ! disarmed.load (std::memory_order_relaxed);
    }
    bool polyStolen() const noexcept { return polyStolenFlag.load (std::memory_order_relaxed); }
    void clearPolyStolen() { polyStolenFlag.store (false, std::memory_order_relaxed); }
    /** 当前播放位置（拍）；无宿主 playhead 时用内部时钟 */
    double getPlayheadBeat() const noexcept { return playheadBeat.load (std::memory_order_relaxed); }

    // --- juce::AudioProcessor ---
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;

   #ifndef JucePlugin_PreferredChannelConfigurations
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
   #endif

    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;
    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // --- 参数布局 ---
    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    // 播放引擎用的解析后事件表（音频线程只读）
    // 由 setProjectFromUI 在消息线程解析，经 mutex 交换
    struct SceneEvents
    {
        juce::String sceneName;
        std::vector<TTNoteEvent> events;   // 已按 audible 过滤
    };
    std::vector<SceneEvents> sceneTable;   // 全部 Scene（供导出）
    std::vector<TTNoteEvent> activeEvents; // 当前 Scene 的可听事件（播放用）
    double projectBpm = 120.0;
    double projectA4  = 440.0;
    juce::String activeSceneName;

    juce::CriticalSection projectLock;   // 保护上面这组数据

    // ---- 撤销/重做快照栈（消息线程专用，存完整工程 JSON）----
    std::vector<juce::String> undoStack, redoStack;
    static constexpr size_t kMaxUndo = 100;

private:
    // ---- 播放状态（音频线程）----
    std::atomic<bool>  playing { false };
    std::atomic<double> playheadBeat { 0.0 };
    std::atomic<bool>  polyStolenFlag { false };

    // UI 停止后即使宿主在播也不发声（DAW 里点停止 = 引擎静音）
    std::atomic<bool>  disarmed { false };
    // 宿主 transport 状态（音频线程写，消息线程读）
    std::atomic<bool>  hostPlayingFlag { false };

    // loop 选区（音频线程读，消息线程写，double 原子对）
    std::atomic<double> loopStart { 0.0 }, loopEnd { 0.0 };
    std::atomic<bool>   hasLoop { false };

    // 内部时钟（无宿主 playhead 时兜底）
    double internalClockBeat = 0.0;
    double lastHostBeat = -1.0;
    bool   hostWasPlaying = false;

    // MPE 通道池：member channel 1..15 → 占用它的音符
    struct VoiceSlot
    {
        bool   active = false;
        int    note   = -1;      // midi note number
        int    synthVoice = -1;  // 内置合成器声部槽位（精确 noteOff 用）
        double endBeat = 0.0;    // 预计结束拍（偷轨道用）
        double bend14 = 8192.0;  // 已发的 pitchbend
    };
    VoiceSlot voiceSlots[15];
    int findFreeSlot();
    int findSlotToSteal (double nowBeat);

    // 调度辅助（均在 projectLock 下调用）
    void markScheduledUpTo (double beat);   // 已结束的事件标记为已发（不回放）
    void fireNoteEvent (const TTNoteEvent& ev, juce::MidiBuffer& midi, int samplePos, double nowBeat);
    void triggerSustainingNotes (double nowBeat, juce::MidiBuffer& midi);   // 播放头在音符中间 → 立即触发

    // 已调度标记（事件索引 → 是否已在本轮播放中发出）
    std::vector<bool> scheduled;

    // UI 侧播放请求（消息线程写）
    std::atomic<bool> uiWantsPlay { false };

    // temp 导出请求
    std::atomic<bool> tempExportPending { false };

    // 上次宿主 bpm（检测变化用）
    double lastBpm = 120.0;

    // ---- 会话持久化：完整 UI 工程 JSON，随 getStateInformation 存盘 ----
    juce::String uiStateJson;

    // seek 后下一块先发全 note off（消息线程置位 → 音频线程执行）
    std::atomic<bool> pendingFlush { false };

    // 播放状态沿检测（替代 processBlock 内的 function-static）
    bool engineWasPlaying = false;
    bool engineWasPlayingPrev = false;

    // 上次 processBlock 的播放位置（检测宿主 seek / 位置跳变）
    double lastProcessBeat = -1.0;

    // 工程末尾（拍）：无 loop 播完自动停，避免播放头跑飞
    double projectEndBeat = 0.0;

    /** 解析 UI 持久化格式（Serialize.save 输出 + ui 字段）→ 播放事件表 */
    void setProjectFromUiState (const juce::String& json);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TotalTuneAudioProcessor)
};

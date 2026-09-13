#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include "TotalTuneProcessor.h"

// =============================================================================
// TotalTune 编辑界面 —— WebView2（Chromium）
//
// 宿主 ↔ 页面事件协议：
//   宿主 → 页面  "ttState"    { playing, playheadBeat, bpm, polyStolen, hostPlaying }
//   页面 → 宿主  "ttSetProject" { json: "<工程 JSON>" }        （编辑/播放/loop 变化）
//   页面 → 宿主  "ttPlay"      { play: true/false }             （播放/暂停）
//   页面 → 宿主  "ttLoop"      { start, end, has }              （loop 选区）
//   页面 → 宿主  "ttWriteFile" { path: "Scene/文件.mid", dataBase64 }  （temp 实时导出）
//   页面 → 宿主  "ttDragFile"  { name, dataBase64 }             （拖出 .mid）
//   页面 → 宿主  "ttSynth"     { vol, wave }                    （小合成器面板）
//   页面 → 宿主  "ttSeek"      { beat }                         （定位播放头）
//   页面 → 宿主  "ttSaveState" { json }                         （完整工程持久化）
//   页面 → 宿主  "ttRequestState" {}                           （页面拉取持久化状态）
//   宿主 → 页面  "ttRestoreState" { json }                       （返回持久化状态）
//
// temp 目录：%TEMP%\TotalTune（Windows 用户级 temp，无需管理员权限，原生写盘）
// =============================================================================
class TotalTuneAudioProcessorEditor : public juce::AudioProcessorEditor,
                                      private juce::Timer
{
public:
    explicit TotalTuneAudioProcessorEditor (TotalTuneAudioProcessor&);
    ~TotalTuneAudioProcessorEditor() override;

    void resized() override;
    void visibilityChanged() override;

    /** temp 根目录：%TEMP%\TotalTune（Windows 用户级 temp） */
    static juce::File tempRoot();

private:
    class WebHost : public juce::WebBrowserComponent
    {
    public:
        WebHost (TotalTuneAudioProcessorEditor& owner, const Options& options)
            : juce::WebBrowserComponent (options), owner (owner) {}

        void pageFinishedLoading (const juce::String& url) override
        {
            tt::log ("pageFinishedLoading: " + url);
            owner.onPageFinishedLoading();
        }

        bool pageAboutToLoad (const juce::String& url) override
        {
            juce::ignoreUnused (url);
            return true;
        }

        bool pageLoadHadNetworkError (const juce::String& errorInfo) override
        {
            tt::log ("pageLoadHadNetworkError: " + errorInfo);
            return true;
        }

        TotalTuneAudioProcessorEditor& owner;
    };

    void onPageFinishedLoading();
    void timerCallback() override;

    // ---- 页面 → 宿主 ----
    void handleSetProject (const juce::var& payload);
    void handlePlay (const juce::var& payload);
    void handleLoop (const juce::var& payload);
    void handleWriteFile (const juce::var& payload);
    void handleDragFile (const juce::var& payload);
    void handleSynth (const juce::var& payload);
    void handleSeek (const juce::var& payload);
    void handleSaveState (const juce::var& payload);
    void handleRequestState();
    void handleUndo();
    void handleRedo();

    // ---- 宿主 → 页面 ----
    void pushState();
    void pushRestoreState();

    // base64 工具
    static juce::String encodeBase64 (const juce::MemoryBlock& mb);
    static juce::MemoryBlock decodeBase64 (const juce::String& s);

    static juce::WebBrowserComponent::Options makeOptions (TotalTuneAudioProcessorEditor& owner);
    static std::optional<juce::WebBrowserComponent::Resource>
        loadResource (const juce::String& url);

    TotalTuneAudioProcessor& processor;
    std::unique_ptr<WebHost> webHost;

    bool pageLoaded = false;

    // 拖拽导出缓存（页面先发 ttDragFile 准备数据，宿主存住，
    // performExternalDragFileDrop 时直接用）
    juce::MemoryBlock pendingDragData;
    juce::String pendingDragName;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TotalTuneAudioProcessorEditor)
};

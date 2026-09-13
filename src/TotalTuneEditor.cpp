#include "TotalTuneEditor.h"
#include "BinaryData.h"

// =============================================================================
// 构造
// =============================================================================
TotalTuneAudioProcessorEditor::TotalTuneAudioProcessorEditor (TotalTuneAudioProcessor& p)
    : AudioProcessorEditor (p), processor (p)
{
    const auto opts = makeOptions (*this);

    tt::log ("=== TotalTune editor constructed ===");
    tt::log ("webview2 options supported: "
                + juce::String (juce::WebBrowserComponent::areOptionsSupported (opts) ? "yes" : "NO"));

    webHost.reset (new WebHost (*this, opts));
    addAndMakeVisible (webHost.get());

    // %TEMP%\TotalTune：系统 temp 永远可写（Program Files 不行）
    auto t = tempRoot();
    t.createDirectory();
    tt::log ("temp root: " + t.getFullPathName());

    setResizable (true, false);
    setResizeLimits (1200, 760, 2400, 1500);

    setSize (1280, 800);
    resized();

    webHost->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    // 30 Hz 心跳：推播放状态/播放头/bpm/复音警告给页面
    startTimerHz (30);
}

TotalTuneAudioProcessorEditor::~TotalTuneAudioProcessorEditor()
{
    stopTimer();
}

juce::File TotalTuneAudioProcessorEditor::tempRoot()
{
    // Windows 用户级 temp（%TEMP%）：VST3 默认装在 Program Files，
    // 那里没有管理员权限写不进 —— 改用系统 temp 目录，永远可写。
    return juce::File::getSpecialLocation (juce::File::tempDirectory)
                .getChildFile ("TotalTune");
}

void TotalTuneAudioProcessorEditor::resized()
{
    if (webHost == nullptr)
        return;
    webHost->setBounds (getLocalBounds());
}

void TotalTuneAudioProcessorEditor::visibilityChanged()
{
    if (isVisible() && pageLoaded)
        pushState();
}

void TotalTuneAudioProcessorEditor::onPageFinishedLoading()
{
    pageLoaded = true;
    pushState();
    // 页面可能还没注册监听器（DOMContentLoaded 竞态）：延迟再推一次恢复状态
    juce::Timer::callAfterDelay (300, [safeThis = juce::Component::SafePointer<TotalTuneAudioProcessorEditor> (this)]
    {
        if (safeThis != nullptr && safeThis->pageLoaded)
            safeThis->pushRestoreState();
    });
}

void TotalTuneAudioProcessorEditor::pushRestoreState()
{
    if (webHost == nullptr)
        return;
    const juce::String json = processor.getUiState();
    if (json.isEmpty())
        return;   // 新实例：无历史状态，页面用默认工程

    auto* obj = new juce::DynamicObject();
    obj->setProperty ("json", json);
    webHost->emitEventIfBrowserIsVisible (juce::Identifier { "ttRestoreState" }, juce::var (obj));
}

// =============================================================================
// 30 Hz 心跳：播放状态 → 页面
// =============================================================================
void TotalTuneAudioProcessorEditor::timerCallback()
{
    if (webHost == nullptr || ! pageLoaded || ! isVisible())
        return;

    pushState();
}

void TotalTuneAudioProcessorEditor::pushState()
{
    if (webHost == nullptr)
        return;

    auto* obj = new juce::DynamicObject();
    obj->setProperty ("playing",     processor.isPlaying());
    obj->setProperty ("playhead",    processor.getPlayheadBeat());
    obj->setProperty ("polyStolen",  processor.polyStolen());

    // 宿主 bpm（UI 只读显示）
    double bpm = 120.0;
    if (auto* ph = processor.getPlayHead())
    {
        juce::AudioPlayHead::CurrentPositionInfo pos;
        if (ph->getCurrentPosition (pos) && pos.bpm > 0.0 && pos.bpm < 999.0)
            bpm = pos.bpm;
    }
    obj->setProperty ("bpm", bpm);

    webHost->emitEventIfBrowserIsVisible (juce::Identifier { "ttState" }, juce::var (obj));
}

// =============================================================================
// 页面 → 宿主：各事件
// =============================================================================
void TotalTuneAudioProcessorEditor::handleSetProject (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;
    processor.setProjectFromUI (obj->getProperty ("json").toString());
}

void TotalTuneAudioProcessorEditor::handlePlay (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;
    processor.setPlayingFromUI ((bool) (int) obj->getProperty ("play"));
}

void TotalTuneAudioProcessorEditor::handleLoop (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;
    const bool has = (bool) (int) obj->getProperty ("has");
    processor.setLoopFromUI ((double) obj->getProperty ("start"),
                             (double) obj->getProperty ("end"), has);
}

void TotalTuneAudioProcessorEditor::handleWriteFile (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;

    const juce::String relPath = obj->getProperty ("path").toString();
    const juce::String b64     = obj->getProperty ("dataBase64").toString();

    // 安全校验：路径不得越出 temp 根
    if (relPath.contains ("..") || relPath.startsWithChar ('/') || relPath.startsWithChar ('\\'))
    {
        tt::log ("ttWriteFile REJECTED (path escape): " + relPath);
        return;
    }

    auto data = decodeBase64 (b64);
    if (data.getSize() == 0)
    {
        tt::log ("ttWriteFile REJECTED (empty): " + relPath);
        return;
    }

    auto target = tempRoot().getChildFile (relPath);
    target.getParentDirectory().createDirectory();

    juce::FileOutputStream fos (target);
    if (fos.openedOk())
    {
        fos.write (data.getData(), data.getSize());
        fos.flush();
        tt::log ("ttWriteFile OK: " + target.getFullPathName() + " (" + juce::String ((int) data.getSize()) + " bytes)");
    }
    else
    {
        tt::log ("ttWriteFile FAIL: " + target.getFullPathName());
    }
}

void TotalTuneAudioProcessorEditor::handleDragFile (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;

    pendingDragName = obj->getProperty ("name").toString();
    pendingDragData = decodeBase64 (obj->getProperty ("dataBase64").toString());

    if (pendingDragData.getSize() == 0 || pendingDragName.isEmpty())
        return;

    // JUCE 原生拖拽：把 .mid 文件拖到宿主/资源管理器
    // 写到 temp 下的 _drag/ 临时文件，再发起系统拖拽
    auto dragDir = tempRoot().getChildFile ("_drag");
    dragDir.createDirectory();
    // ★ 唯一文件名：目标程序可能仍锁着上一次的同名文件，导致后续 FileOutputStream 失败（只能拖一次的根因）
    auto unique = pendingDragName + "_" + juce::String (juce::Time::currentTimeMillis()) + ".mid";
    auto dragFile = dragDir.getChildFile (unique);
    juce::FileOutputStream fos (dragFile);
    if (fos.openedOk())
    {
        fos.write (pendingDragData.getData(), pendingDragData.getSize());
        fos.flush();

        // performExternalDragDropOfFiles 必须在消息线程（这里就是）；
        // 延迟一拍让本事件处理先返回，避免嵌套在 WebView2 回调里起 OLE 拖拽循环
        juce::Timer::callAfterDelay (0, [dragFile]
        {
            juce::DragAndDropContainer::performExternalDragDropOfFiles (
                juce::StringArray { dragFile.getFullPathName() }, true, nullptr,
                [dragFile] { dragFile.deleteFile(); });
        });
    }
}

void TotalTuneAudioProcessorEditor::handleSeek (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;
    processor.seekTo ((double) obj->getProperty ("beat"));
}

void TotalTuneAudioProcessorEditor::handleSaveState (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;
    processor.setUiStateFromUI (obj->getProperty ("json").toString());
}

void TotalTuneAudioProcessorEditor::handleRequestState()
{
    pushRestoreState();
}

void TotalTuneAudioProcessorEditor::handleUndo()
{
    const juce::String json = processor.undoFromUI();
    if (json.isEmpty())
        return;   // 无可撤销：不打扰页面

    // 撤销后的状态推回页面（页面 applyRestored）+ 同步引擎
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("json", json);
    webHost->emitEventIfBrowserIsVisible (juce::Identifier { "ttRestoreState" }, juce::var (obj));
}

void TotalTuneAudioProcessorEditor::handleRedo()
{
    const juce::String json = processor.redoFromUI();
    if (json.isEmpty())
        return;

    auto* obj = new juce::DynamicObject();
    obj->setProperty ("json", json);
    webHost->emitEventIfBrowserIsVisible (juce::Identifier { "ttRestoreState" }, juce::var (obj));
}

void TotalTuneAudioProcessorEditor::handleSynth (const juce::var& payload)
{
    auto* obj = payload.getDynamicObject();
    if (obj == nullptr) return;

    const float vol  = (float) (double) obj->getProperty ("vol");
    const int   wave = (int) obj->getProperty ("wave");

    if (auto* p = processor.apvts.getParameter (TotalTuneAudioProcessor::idSynthVol))
        p->setValueNotifyingHost (p->convertTo0to1 (vol));
    if (auto* p = processor.apvts.getParameter (TotalTuneAudioProcessor::idSynthWave))
        p->setValueNotifyingHost (p->convertTo0to1 ((float) wave));
}

// =============================================================================
// base64
// =============================================================================
juce::String TotalTuneAudioProcessorEditor::encodeBase64 (const juce::MemoryBlock& mb)
{
    return juce::Base64::toBase64 (mb.getData(), mb.getSize());
}

juce::MemoryBlock TotalTuneAudioProcessorEditor::decodeBase64 (const juce::String& s)
{
    juce::MemoryOutputStream mos;
    juce::Base64::convertFromBase64 (mos, s);
    return juce::MemoryBlock (mos.getMemoryBlock());
}

// =============================================================================
// WebBrowserComponent 选项
// =============================================================================
juce::WebBrowserComponent::Options
TotalTuneAudioProcessorEditor::makeOptions (TotalTuneAudioProcessorEditor& owner)
{
    using namespace juce;

    const auto appPath = File::getSpecialLocation (File::currentApplicationFile).getFullPathName();
    const String suffix = appPath.isNotEmpty()
                            ? String::toHexString (appPath.hashCode())
                            : String (Time::currentTimeMillis());

    File userData = File::getSpecialLocation (File::tempDirectory)
                        .getChildFile ("TotalTune_WebView2")
                        .getChildFile (suffix);
    userData.createDirectory();

    const auto win = WebBrowserComponent::Options::WinWebView2 {}
                         .withBackgroundColour (Colour { 0xff1e1f25 })
                         .withUserDataFolder (userData);

    return WebBrowserComponent::Options {}
        .withBackend (WebBrowserComponent::Options::Backend::webview2)
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider (&loadResource)
        .withEventListener (Identifier { "ttSetProject" },
            [&owner] (const var& p) { owner.handleSetProject (p); })
        .withEventListener (Identifier { "ttPlay" },
            [&owner] (const var& p) { owner.handlePlay (p); })
        .withEventListener (Identifier { "ttLoop" },
            [&owner] (const var& p) { owner.handleLoop (p); })
        .withEventListener (Identifier { "ttWriteFile" },
            [&owner] (const var& p) { owner.handleWriteFile (p); })
        .withEventListener (Identifier { "ttDragFile" },
            [&owner] (const var& p) { owner.handleDragFile (p); })
        .withEventListener (Identifier { "ttSynth" },
            [&owner] (const var& p) { owner.handleSynth (p); })
        .withEventListener (Identifier { "ttSeek" },
            [&owner] (const var& p) { owner.handleSeek (p); })
        .withEventListener (Identifier { "ttSaveState" },
            [&owner] (const var& p) { owner.handleSaveState (p); })
        .withEventListener (Identifier { "ttRequestState" },
            [&owner] (const var&) { owner.handleRequestState(); })
        .withEventListener (Identifier { "ttUndo" },
            [&owner] (const var&) { owner.handleUndo(); })
        .withEventListener (Identifier { "ttRedo" },
            [&owner] (const var&) { owner.handleRedo(); })
        .withWinWebView2Options (win);
}

// =============================================================================
// ResourceProvider
// =============================================================================
std::optional<juce::WebBrowserComponent::Resource>
TotalTuneAudioProcessorEditor::loadResource (const juce::String& urlIn)
{
    using Resource = juce::WebBrowserComponent::Resource;

    juce::String url = urlIn.upToFirstOccurrenceOf ("?", false, false)
                            .upToFirstOccurrenceOf ("#", false, false);
    if (! url.startsWithChar ('/'))
        url = "/" + url;

    struct Entry { const char* path; const char* data; size_t size; const char* mime; };

    static const Entry entries[] =
    {
        { "/",                  TotalTuneUI::index_html,          TotalTuneUI::index_htmlSize,          "text/html; charset=utf-8" },
        { "/index.html",        TotalTuneUI::index_html,          TotalTuneUI::index_htmlSize,          "text/html; charset=utf-8" },
        { "/css/style.css",     TotalTuneUI::style_css,           TotalTuneUI::style_cssSize,           "text/css; charset=utf-8" },
        { "/js/tuning.js",      TotalTuneUI::tuning_js,           TotalTuneUI::tuning_jsSize,           "application/javascript; charset=utf-8" },
        { "/js/model.js",       TotalTuneUI::model_js,            TotalTuneUI::model_jsSize,            "application/javascript; charset=utf-8" },
        { "/js/serialize.js",   TotalTuneUI::serialize_js,        TotalTuneUI::serialize_jsSize,        "application/javascript; charset=utf-8" },
        { "/js/mpe_export.js",  TotalTuneUI::mpe_export_js,       TotalTuneUI::mpe_export_jsSize,       "application/javascript; charset=utf-8" },
        { "/js/live_export.js", TotalTuneUI::live_export_js,      TotalTuneUI::live_export_jsSize,      "application/javascript; charset=utf-8" },
        { "/js/audio.js",       TotalTuneUI::audio_js,            TotalTuneUI::audio_jsSize,            "application/javascript; charset=utf-8" },
        { "/js/keycolumn.js",   TotalTuneUI::keycolumn_js,        TotalTuneUI::keycolumn_jsSize,        "application/javascript; charset=utf-8" },
        { "/js/tuningcolumn.js",TotalTuneUI::tuningcolumn_js,     TotalTuneUI::tuningcolumn_jsSize,     "application/javascript; charset=utf-8" },
        { "/js/editor.js",      TotalTuneUI::editor_js,           TotalTuneUI::editor_jsSize,           "application/javascript; charset=utf-8" },
        { "/js/manager.js",     TotalTuneUI::manager_js,          TotalTuneUI::manager_jsSize,          "application/javascript; charset=utf-8" },
        { "/js/app.js",         TotalTuneUI::app_js,              TotalTuneUI::app_jsSize,              "application/javascript; charset=utf-8" },
        { "/js/bridge.js",      TotalTuneUI::bridge_js,           TotalTuneUI::bridge_jsSize,           "application/javascript; charset=utf-8" },
    };

    for (const auto& e : entries)
    {
        if (url == e.path)
        {
            Resource r;
            r.mimeType = e.mime;
            r.data.assign (reinterpret_cast<const std::byte*> (e.data),
                           reinterpret_cast<const std::byte*> (e.data) + e.size);
            return r;
        }
    }

    tt::log ("resource MISS: " + urlIn);
    return std::nullopt;
}

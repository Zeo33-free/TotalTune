cmake_minimum_required(VERSION 3.22)

project(TotalTune
    VERSION 1.0.0
    DESCRIPTION "R1C1N TotalTune — just-intonation MPE MIDI editor"
    LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
    add_compile_options(/utf-8)
endif()

# ===========================================================================
# 构建教程
#
# 依赖：CMake >= 3.22、C++17 编译器（MSVC / Xcode / gcc / clang）
#
# JUCE 二选一：
#   1) -DJUCE_ROOT=<本地 JUCE 源码路径>（默认，推荐）
#   2) -DTOTALTUNE_FETCH_JUCE=ON（自动从 GitHub 下载 JUCE 8.0.5，需联网）
#
# Windows（VS 2022）：
#   cmake -B build -DJUCE_ROOT=E:/JUCE
#   cmake --build build --config Release
#   产物：
#     build/TotalTune_artefacts/Release/VST3/TotalTune.vst3        （MIDI 效果器）
#     build/TotalTuneInst_artefacts/Release/VST3/TotalTuneInst.vst3（乐器）
#     build/TotalTune_artefacts/Release/Standalone/TotalTune.exe
#
# macOS（Xcode）：
#   cmake -B build -G Xcode -DJUCE_ROOT=/path/to/JUCE
#   cmake --build build --config Release
#   产物：AU + VST3 + Standalone（AU 供 Logic / GarageBand 使用）
#
# 多版本 JUCE 并存：用不同 build 目录，如 -B build / -B build9
# ===========================================================================

option(TOTALTUNE_FETCH_JUCE "Fetch JUCE from GitHub" OFF)

if(TOTALTUNE_FETCH_JUCE)
    include(FetchContent)
    FetchContent_Declare(juce
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.5
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(juce)
else()
    if(NOT DEFINED JUCE_ROOT)
        message(FATAL_ERROR
            "JUCE not found. Pass -DJUCE_ROOT=<path to JUCE source>, "
            "or use -DTOTALTUNE_FETCH_JUCE=ON to download automatically.")
    endif()
    if(NOT EXISTS "${JUCE_ROOT}/CMakeLists.txt")
        message(FATAL_ERROR "Invalid JUCE_ROOT (no CMakeLists.txt): ${JUCE_ROOT}")
    endif()
    add_subdirectory("${JUCE_ROOT}" juce)
endif()

juce_add_plugin(TotalTune
    COMPANY_NAME                "R1C1N"
    COMPANY_COPYRIGHT           "Copyright (c) 2026 R1C1N"
    BUNDLE_ID                   "com.r1c1n.TotalTune"
    PRODUCT_NAME                "TotalTune"
    VERSION                     "1.0.0"
    DESCRIPTION                 "Just-intonation MPE MIDI editor / generator"
    PLUGIN_MANUFACTURER_CODE    GsSt
    PLUGIN_CODE                 TtUn
    FORMATS                     VST3 AU Standalone
    IS_SYNTH                    FALSE
    IS_MIDI_EFFECT              TRUE
    NEEDS_MIDI_INPUT            TRUE
    NEEDS_MIDI_OUTPUT           TRUE
    NEEDS_WEBVIEW2              TRUE
    COPY_PLUGIN_AFTER_BUILD     FALSE
)

juce_add_plugin(TotalTuneInst
    COMPANY_NAME                "R1C1N"
    COMPANY_COPYRIGHT           "Copyright (c) 2026 R1C1N"
    BUNDLE_ID                   "com.r1c1n.TotalTuneInst"
    PRODUCT_NAME                "TotalTuneInst"
    VERSION                     "1.0.0"
    DESCRIPTION                 "Just-intonation MPE MIDI instrument"
    PLUGIN_MANUFACTURER_CODE    GsSt
    PLUGIN_CODE                 TtIn
    FORMATS                     VST3 AU
    IS_SYNTH                    TRUE
    IS_MIDI_EFFECT              FALSE
    NEEDS_MIDI_INPUT            TRUE
    NEEDS_MIDI_OUTPUT           FALSE
    NEEDS_WEBVIEW2              TRUE
    COPY_PLUGIN_AFTER_BUILD     FALSE
)

file(REMOVE "${CMAKE_CURRENT_BINARY_DIR}/TotalTune_artefacts/JuceLibraryCode/TotalTune_resources.rc")
file(REMOVE "${CMAKE_CURRENT_BINARY_DIR}/TotalTuneInst_artefacts/JuceLibraryCode/TotalTuneInst_resources.rc")

juce_add_binary_data(TotalTuneUI
    NAMESPACE TotalTuneUI
    SOURCES
        ui_totaltune/index.html
        ui_totaltune/css/style.css
        ui_totaltune/js/tuning.js
        ui_totaltune/js/model.js
        ui_totaltune/js/serialize.js
        ui_totaltune/js/mpe_export.js
        ui_totaltune/js/live_export.js
        ui_totaltune/js/audio.js
        ui_totaltune/js/keycolumn.js
        ui_totaltune/js/tuningcolumn.js
        ui_totaltune/js/editor.js
        ui_totaltune/js/manager.js
        ui_totaltune/js/app.js
        ui_totaltune/js/bridge.js
)

foreach(_tt TotalTune TotalTuneInst)

target_compile_features(${_tt} PRIVATE cxx_std_17)
target_compile_definitions(${_tt} PRIVATE
    JUCE_VST3_CAN_REPLACE_VST2=0
)

if(WIN32)
    target_compile_definitions(${_tt} PRIVATE
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    )
endif()

target_sources(${_tt} PRIVATE
    src/TotalTuneProcessor.cpp
    src/TotalTuneEditor.cpp
)

target_include_directories(${_tt} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")

target_link_libraries(${_tt} PRIVATE
    juce::juce_audio_plugin_client
    juce::juce_audio_processors
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_utils
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
    juce::juce_core
    TotalTuneUI
)

if(MSVC)
    target_compile_options(${_tt} PRIVATE /W4)
else()
    target_compile_options(${_tt} PRIVATE -Wall -Wextra)
endif()

endforeach()

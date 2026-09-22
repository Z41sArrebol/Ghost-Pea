mod audio;

use std::sync::Arc;

use audio::{
    AiPcmStatus, AudioFeatures, AudioMonitor, AudioStatus, DspPerformance, FeatureSink,
    PerformanceSink, WindowSink,
};
#[cfg(debug_assertions)]
use tauri::Manager;
use tauri::{ipc::Channel, ipc::InvokeResponseBody, AppHandle, Emitter, State};

const AUDIO_FEATURES_EVENT: &str = "audio-features";
const AUDIO_PERFORMANCE_EVENT: &str = "audio-performance";

fn feature_sink(app: AppHandle) -> FeatureSink {
    Arc::new(move |features: AudioFeatures| {
        if let Err(error) = app.emit(AUDIO_FEATURES_EVENT, features) {
            eprintln!("[audio] failed to emit features: {error}");
        }
    })
}

fn performance_sink(app: AppHandle) -> PerformanceSink {
    Arc::new(move |performance: DspPerformance| {
        if let Err(error) = app.emit(AUDIO_PERFORMANCE_EVENT, performance) {
            eprintln!("[audio] failed to emit performance: {error}");
        }
    })
}

#[tauri::command]
fn start_audio_monitor(
    app: AppHandle,
    monitor: State<'_, AudioMonitor>,
) -> Result<AudioStatus, String> {
    monitor.start(feature_sink(app.clone()), performance_sink(app))
}

#[tauri::command]
fn stop_audio_monitor(monitor: State<'_, AudioMonitor>) -> Result<AudioStatus, String> {
    monitor.stop()
}

#[tauri::command]
fn audio_monitor_status(monitor: State<'_, AudioMonitor>) -> Result<AudioStatus, String> {
    monitor.status()
}

#[tauri::command]
fn audio_performance_status(monitor: State<'_, AudioMonitor>) -> Result<DspPerformance, String> {
    monitor.performance_status()
}

#[tauri::command]
fn start_ai_pcm_stream(
    monitor: State<'_, AudioMonitor>,
    channel: Channel<InvokeResponseBody>,
) -> Result<AiPcmStatus, String> {
    let sink: WindowSink = Arc::new(move |payload| {
        channel
            .send(InvokeResponseBody::Raw(payload))
            .map_err(|error| error.to_string())
    });
    monitor.start_ai_pcm(sink)
}

#[tauri::command]
fn stop_ai_pcm_stream(monitor: State<'_, AudioMonitor>) -> Result<AiPcmStatus, String> {
    monitor.stop_ai_pcm()
}

#[tauri::command]
fn ai_pcm_status(monitor: State<'_, AudioMonitor>) -> Result<AiPcmStatus, String> {
    monitor.ai_pcm_status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioMonitor::default())
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                let app = _app;
                let monitor = app.state::<AudioMonitor>();
                let handle = app.handle().clone();
                if let Err(error) =
                    monitor.start(feature_sink(handle.clone()), performance_sink(handle))
                {
                    eprintln!("[audio] failed to auto-start monitor: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_audio_monitor,
            stop_audio_monitor,
            audio_monitor_status,
            audio_performance_status,
            start_ai_pcm_stream,
            stop_ai_pcm_stream,
            ai_pcm_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

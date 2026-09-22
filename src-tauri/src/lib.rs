mod audio;

use std::sync::Arc;

use audio::{
    AiPcmStatus, AudioFeatures, AudioMonitor, AudioStatus, DspPerformance, FeatureSink,
    PerformanceSink, WindowSink,
};
use tauri::Manager;
use tauri::{ipc::Channel, ipc::InvokeResponseBody, AppHandle, Emitter};

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
async fn start_audio_monitor(app: AppHandle) -> Result<AudioStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let monitor = app.state::<AudioMonitor>();
        monitor.start(feature_sink(app.clone()), performance_sink(app.clone()))
    })
    .await
    .map_err(|error| format!("audio start task failed: {error}"))?
}

#[tauri::command]
async fn stop_audio_monitor(app: AppHandle) -> Result<AudioStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AudioMonitor>().stop())
        .await
        .map_err(|error| format!("audio stop task failed: {error}"))?
}

#[tauri::command]
async fn audio_monitor_status(app: AppHandle) -> Result<AudioStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AudioMonitor>().status())
        .await
        .map_err(|error| format!("audio status task failed: {error}"))?
}

#[tauri::command]
async fn audio_performance_status(app: AppHandle) -> Result<DspPerformance, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AudioMonitor>().performance_status())
        .await
        .map_err(|error| format!("audio performance task failed: {error}"))?
}

#[tauri::command]
async fn start_ai_pcm_stream(
    app: AppHandle,
    channel: Channel<InvokeResponseBody>,
) -> Result<AiPcmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sink: WindowSink = Arc::new(move |payload| {
            channel
                .send(InvokeResponseBody::Raw(payload))
                .map_err(|error| error.to_string())
        });
        app.state::<AudioMonitor>().start_ai_pcm(sink)
    })
    .await
    .map_err(|error| format!("AI PCM start task failed: {error}"))?
}

#[tauri::command]
async fn stop_ai_pcm_stream(app: AppHandle) -> Result<AiPcmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AudioMonitor>().stop_ai_pcm())
        .await
        .map_err(|error| format!("AI PCM stop task failed: {error}"))?
}

#[tauri::command]
async fn ai_pcm_status(app: AppHandle) -> Result<AiPcmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AudioMonitor>().ai_pcm_status())
        .await
        .map_err(|error| format!("AI PCM status task failed: {error}"))?
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

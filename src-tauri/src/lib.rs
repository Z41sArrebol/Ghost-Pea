mod audio;

use audio::{AudioMonitor, AudioStatus};
use tauri::{Manager, State};

#[tauri::command]
fn start_audio_monitor(monitor: State<'_, AudioMonitor>) -> Result<AudioStatus, String> {
    monitor.start()
}

#[tauri::command]
fn stop_audio_monitor(monitor: State<'_, AudioMonitor>) -> Result<AudioStatus, String> {
    monitor.stop()
}

#[tauri::command]
fn audio_monitor_status(monitor: State<'_, AudioMonitor>) -> Result<AudioStatus, String> {
    monitor.status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioMonitor::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let monitor = app.state::<AudioMonitor>();
                if let Err(error) = monitor.start() {
                    eprintln!("[audio] failed to auto-start monitor: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_audio_monitor,
            stop_audio_monitor,
            audio_monitor_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

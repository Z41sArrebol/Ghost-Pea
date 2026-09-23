mod ai_pcm;
mod metrics;
mod microphone_mix;

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use realfft::{num_complex::Complex32, RealFftPlanner, RealToComplex};
use ringbuf::{traits::*, HeapRb};
use serde::Serialize;
use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use ai_pcm::SharedAiPcm;
pub use ai_pcm::{AiPcmStatus, WindowSink};
pub use metrics::DspPerformance;
use metrics::{DspMetrics, SharedDspPerformance};
use microphone_mix::{MicrophoneMix, MicrophoneSettings};

const CAPTURE_BUFFER_MILLIS: usize = 250;
const MAX_AI_INPUT_SAMPLE_RATE_HZ: usize = 192_000;
const EVENT_WAIT_MILLIS: u32 = 50;
const HEALTH_CHECK_TIMEOUTS: u32 = 20;
const FFT_SIZE: usize = 2048;
const DSP_HOP_SIZE: usize = 512;
const FEATURE_EVENT_INTERVAL: Duration = Duration::from_micros(16_667);
const SILENCE_RMS: f32 = 0.001;

pub type FeatureSink = Arc<dyn Fn(AudioFeatures) + Send + Sync + 'static>;
pub type PerformanceSink = Arc<dyn Fn(DspPerformance) + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioRuntimeState {
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

impl AudioRuntimeState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Starting,
            2 => Self::Running,
            3 => Self::Stopping,
            4 => Self::Failed,
            _ => Self::Stopped,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub running: bool,
    pub state: AudioRuntimeState,
    pub last_error: Option<String>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub captured_frames: u64,
    pub dropped_samples: u64,
    pub sequence: u64,
    pub captured_at_us: u64,
    pub rms: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub onset: f32,
    pub centroid: f32,
    pub energy_trend: f32,
    pub silence: bool,
    pub microphone_enabled: bool,
    pub microphone_level: f32,
    pub microphone_gate: f32,
    pub microphone_gain: f32,
}

struct SharedRuntime {
    state: AtomicU32,
    last_error: Mutex<Option<String>>,
}

impl SharedRuntime {
    fn new() -> Self {
        Self {
            state: AtomicU32::new(AudioRuntimeState::Starting as u32),
            last_error: Mutex::new(None),
        }
    }

    fn state(&self) -> AudioRuntimeState {
        AudioRuntimeState::from_u8(self.state.load(Ordering::Acquire) as u8)
    }

    fn set_state(&self, state: AudioRuntimeState) {
        self.state.store(state as u32, Ordering::Release);
    }

    fn fail(&self, error: String) {
        *self
            .last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
        self.set_state(AudioRuntimeState::Failed);
    }

    fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[derive(Default)]
struct SharedStats {
    sample_rate_hz: AtomicU64,
    channels: AtomicU64,
    captured_frames: AtomicU64,
    dropped_samples: AtomicU64,
    sequence: AtomicU64,
    captured_at_us: AtomicU64,
    rms_bits: AtomicU32,
    bass_bits: AtomicU32,
    mid_bits: AtomicU32,
    treble_bits: AtomicU32,
    onset_bits: AtomicU32,
    centroid_bits: AtomicU32,
    energy_trend_bits: AtomicU32,
    silence: AtomicBool,
}

impl SharedStats {
    fn snapshot(&self, runtime: &SharedRuntime, mic: &SharedMicFeedback) -> AudioStatus {
        let state = runtime.state();
        AudioStatus {
            running: state == AudioRuntimeState::Running,
            state,
            last_error: runtime.last_error(),
            sample_rate_hz: self.sample_rate_hz.load(Ordering::Relaxed) as u32,
            channels: self.channels.load(Ordering::Relaxed) as u16,
            captured_frames: self.captured_frames.load(Ordering::Relaxed),
            dropped_samples: self.dropped_samples.load(Ordering::Relaxed),
            sequence: self.sequence.load(Ordering::Acquire),
            captured_at_us: self.captured_at_us.load(Ordering::Relaxed),
            rms: f32::from_bits(self.rms_bits.load(Ordering::Relaxed)),
            bass: f32::from_bits(self.bass_bits.load(Ordering::Relaxed)),
            mid: f32::from_bits(self.mid_bits.load(Ordering::Relaxed)),
            treble: f32::from_bits(self.treble_bits.load(Ordering::Relaxed)),
            onset: f32::from_bits(self.onset_bits.load(Ordering::Relaxed)),
            centroid: f32::from_bits(self.centroid_bits.load(Ordering::Relaxed)),
            energy_trend: f32::from_bits(self.energy_trend_bits.load(Ordering::Relaxed)),
            silence: self.silence.load(Ordering::Relaxed),
            microphone_enabled: mic.enabled.load(Ordering::Relaxed),
            microphone_level: f32::from_bits(mic.level_bits.load(Ordering::Relaxed)),
            microphone_gate: f32::from_bits(mic.gate_bits.load(Ordering::Relaxed)),
            microphone_gain: f32::from_bits(mic.gain_bits.load(Ordering::Relaxed)),
        }
    }

    fn publish_features(&self, features: AudioFeatures) {
        self.captured_at_us
            .store(features.captured_at_us, Ordering::Relaxed);
        self.rms_bits
            .store(features.rms.to_bits(), Ordering::Relaxed);
        self.bass_bits
            .store(features.bass.to_bits(), Ordering::Relaxed);
        self.mid_bits
            .store(features.mid.to_bits(), Ordering::Relaxed);
        self.treble_bits
            .store(features.treble.to_bits(), Ordering::Relaxed);
        self.onset_bits
            .store(features.onset.to_bits(), Ordering::Relaxed);
        self.centroid_bits
            .store(features.centroid.to_bits(), Ordering::Relaxed);
        self.energy_trend_bits
            .store(features.energy_trend.to_bits(), Ordering::Relaxed);
        self.silence.store(features.silence, Ordering::Relaxed);
        self.sequence.store(features.sequence, Ordering::Release);
    }
}

/// 麦克风混音的实时读数，供状态快照读取（DSP 线程写入，命令线程读取）。
#[derive(Default)]
struct SharedMicFeedback {
    enabled: AtomicBool,
    level_bits: AtomicU32,
    gate_bits: AtomicU32,
    gain_bits: AtomicU32,
}

impl SharedMicFeedback {
    fn publish(&self, enabled: bool, level: f32, gate: f32, gain: f32) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.level_bits.store(level.to_bits(), Ordering::Relaxed);
        self.gate_bits.store(gate.to_bits(), Ordering::Relaxed);
        self.gain_bits.store(gain.to_bits(), Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFeatures {
    pub sequence: u64,
    pub captured_at_us: u64,
    pub rms: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub onset: f32,
    pub centroid: f32,
    pub energy_trend: f32,
    pub silence: bool,
}

struct RunningAudio {
    stop: Arc<AtomicBool>,
    microphone_stop: Arc<AtomicBool>,
    capture_thread: JoinHandle<()>,
    microphone_thread: Option<JoinHandle<()>>,
    dsp_thread: JoinHandle<()>,
    ai_pcm_thread: JoinHandle<()>,
    stats: Arc<SharedStats>,
    microphone_stats: Arc<SharedStats>,
    performance: Arc<SharedDspPerformance>,
    runtime: Arc<SharedRuntime>,
    ai_pcm: Arc<SharedAiPcm>,
    microphone_feedback: Arc<SharedMicFeedback>,
}

#[derive(Default)]
pub struct AudioMonitor {
    lifecycle: Mutex<()>,
    running: Mutex<Option<RunningAudio>>,
    /// 麦克风混音设置：跨会话保留，前端可随时热更新。
    microphone_settings: Arc<MicrophoneSettings>,
}

impl AudioMonitor {
    pub fn start(
        &self,
        feature_sink: FeatureSink,
        performance_sink: PerformanceSink,
    ) -> Result<AudioStatus, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "audio lifecycle state poisoned")?;
        let mut running = self.running.lock().map_err(|_| "audio state poisoned")?;
        if let Some(active) = running.as_ref() {
            match active.runtime.state() {
                AudioRuntimeState::Starting | AudioRuntimeState::Running => {
                    return Ok(active.stats.snapshot(&active.runtime, &active.microphone_feedback));
                }
                AudioRuntimeState::Stopping => {
                    return Err("audio monitor is stopping".into());
                }
                AudioRuntimeState::Stopped | AudioRuntimeState::Failed => {}
            }
        }

        if let Some(stale) = running.take() {
            stale.stop.store(true, Ordering::Release);
            stale.microphone_stop.store(true, Ordering::Release);
            stale
                .capture_thread
                .join()
                .map_err(|_| "previous WASAPI thread panicked")?;
            if let Some(thread) = stale.microphone_thread {
                thread
                    .join()
                    .map_err(|_| "previous microphone thread panicked")?;
            }
            stale
                .dsp_thread
                .join()
                .map_err(|_| "previous DSP thread panicked")?;
            stale
                .ai_pcm_thread
                .join()
                .map_err(|_| "previous AI PCM thread panicked")?;
        }

        let stop = Arc::new(AtomicBool::new(false));
        let microphone_stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(SharedStats::default());
        let performance = Arc::new(SharedDspPerformance::default());
        let runtime = Arc::new(SharedRuntime::new());
        let capacity = MAX_AI_INPUT_SAMPLE_RATE_HZ * CAPTURE_BUFFER_MILLIS / 1_000;
        let ring = HeapRb::<f32>::new(capacity);
        let (producer, consumer) = ring.split();
        let microphone_ring = HeapRb::<f32>::new(capacity);
        let (microphone_producer, microphone_consumer) = microphone_ring.split();
        let microphone_stats = Arc::new(SharedStats::default());
        let ai_ring =
            HeapRb::<f32>::new(MAX_AI_INPUT_SAMPLE_RATE_HZ * ai_pcm::RING_BUFFER_MILLIS / 1_000);
        let (ai_producer, ai_consumer) = ai_ring.split();
        let ai_pcm = Arc::new(SharedAiPcm::default());

        let ai_stop = Arc::clone(&stop);
        let ai_stats = Arc::clone(&stats);
        let ai_shared = Arc::clone(&ai_pcm);
        let ai_pcm_thread = thread::Builder::new()
            .name("ghost-pea-ai-pcm".into())
            .spawn(move || ai_pcm::run(ai_consumer, ai_stop, ai_stats, ai_shared))
            .map_err(|error| format!("failed to spawn AI PCM thread: {error}"))?;

        let dsp_stop = Arc::clone(&stop);
        let dsp_stats = Arc::clone(&stats);
        let dsp_performance = Arc::clone(&performance);
        let dsp_runtime = Arc::clone(&runtime);
        let dsp_ai_pcm = Arc::clone(&ai_pcm);
        let dsp_microphone_stats = Arc::clone(&microphone_stats);
        let microphone_feedback = Arc::new(SharedMicFeedback::default());
        let dsp_microphone_feedback = Arc::clone(&microphone_feedback);
        let dsp_microphone_settings = Arc::clone(&self.microphone_settings);
        let dsp_thread =
            match thread::Builder::new()
                .name("ghost-pea-dsp".into())
                .spawn(move || {
                    run_dsp(
                        DspChannels {
                            consumer,
                            microphone_consumer,
                            microphone_stats: dsp_microphone_stats,
                            microphone_feedback: dsp_microphone_feedback,
                            ai_producer,
                            ai_pcm: dsp_ai_pcm,
                        },
                        dsp_stop,
                        dsp_stats,
                        dsp_performance,
                        dsp_runtime,
                        dsp_microphone_settings,
                        feature_sink,
                        performance_sink,
                    )
                }) {
                Ok(handle) => handle,
                Err(error) => {
                    stop.store(true, Ordering::Release);
                    let _ = ai_pcm_thread.join();
                    return Err(format!("failed to spawn DSP thread: {error}"));
                }
            };

        let capture_stop = Arc::clone(&stop);
        let capture_microphone_stop = Arc::clone(&microphone_stop);
        let capture_stats = Arc::clone(&stats);
        let capture_runtime = Arc::clone(&runtime);
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let capture_thread = match thread::Builder::new()
            .name("ghost-pea-wasapi".into())
            .spawn(move || {
                if let Err(error) = run_capture(
                    producer,
                    &capture_stop,
                    &capture_stats,
                    &capture_runtime,
                    startup_tx,
                ) {
                    if !capture_stop.load(Ordering::Acquire) {
                        capture_runtime.fail(error.clone());
                    }
                    capture_stop.store(true, Ordering::Release);
                    capture_microphone_stop.store(true, Ordering::Release);
                    eprintln!("WASAPI capture stopped: {error}");
                }
            }) {
            Ok(handle) => handle,
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = dsp_thread.join();
                let _ = ai_pcm_thread.join();
                return Err(format!("failed to spawn WASAPI thread: {error}"));
            }
        };

        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                let mic_stop = Arc::clone(&microphone_stop);
                let mic_stats = Arc::clone(&microphone_stats);
                let (mic_tx, mic_rx) = mpsc::sync_channel(1);
                let microphone_thread = match thread::Builder::new()
                    .name("ghost-pea-microphone".into())
                    .spawn(move || {
                        if let Err(error) = run_microphone_capture(
                            microphone_producer,
                            &mic_stop,
                            &mic_stats,
                            mic_tx,
                        ) {
                            eprintln!("[audio] microphone unavailable: {error}");
                        }
                        mic_stats.sample_rate_hz.store(0, Ordering::Release);
                    }) {
                    Ok(handle) => match mic_rx.recv_timeout(Duration::from_secs(3)) {
                        Ok(Ok(())) => {
                            eprintln!(
                                "[audio] microphone active: {} Hz, {} channels",
                                microphone_stats.sample_rate_hz.load(Ordering::Acquire),
                                microphone_stats.channels.load(Ordering::Relaxed)
                            );
                            Some(handle)
                        }
                        Ok(Err(error)) => {
                            eprintln!("[audio] using system audio only: {error}");
                            let _ = handle.join();
                            None
                        }
                        Err(error) => {
                            eprintln!("[audio] microphone startup uncertain, using system audio only: {error}");
                            microphone_stop.store(true, Ordering::Release);
                            Some(handle)
                        }
                    },
                    Err(error) => {
                        eprintln!("[audio] using system audio only: failed to spawn microphone thread: {error}");
                        None
                    }
                };
                let status = stats.snapshot(&runtime, &microphone_feedback);
                eprintln!(
                    "[audio] monitor started: {} Hz, {} channels",
                    status.sample_rate_hz, status.channels
                );
                *running = Some(RunningAudio {
                    stop,
                    microphone_stop,
                    capture_thread,
                    microphone_thread,
                    dsp_thread,
                    ai_pcm_thread,
                    stats,
                    microphone_stats,
                    performance,
                    runtime,
                    ai_pcm,
                    microphone_feedback,
                });
                Ok(status)
            }
            Ok(Err(error)) => {
                runtime.fail(error.clone());
                stop.store(true, Ordering::Release);
                let _ = capture_thread.join();
                let _ = dsp_thread.join();
                let _ = ai_pcm_thread.join();
                Err(error)
            }
            Err(error) => {
                runtime.fail(format!("WASAPI startup timed out: {error}"));
                stop.store(true, Ordering::Release);
                let _ = capture_thread.join();
                let _ = dsp_thread.join();
                let _ = ai_pcm_thread.join();
                Err(format!("WASAPI startup timed out: {error}"))
            }
        }
    }

    pub fn stop(&self) -> Result<AudioStatus, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "audio lifecycle state poisoned")?;
        let active = self
            .running
            .lock()
            .map_err(|_| "audio state poisoned")?
            .take();

        let Some(active) = active else {
            return Ok(AudioStatus::default());
        };

        active.runtime.set_state(AudioRuntimeState::Stopping);
        active.stop.store(true, Ordering::Release);
        active.microphone_stop.store(true, Ordering::Release);
        active
            .capture_thread
            .join()
            .map_err(|_| "WASAPI thread panicked")?;
        if let Some(thread) = active.microphone_thread {
            thread.join().map_err(|_| "microphone thread panicked")?;
        }
        active
            .dsp_thread
            .join()
            .map_err(|_| "DSP thread panicked")?;
        active
            .ai_pcm_thread
            .join()
            .map_err(|_| "AI PCM thread panicked")?;
        active.runtime.set_state(AudioRuntimeState::Stopped);
        let status = active
            .stats
            .snapshot(&active.runtime, &active.microphone_feedback);
        eprintln!(
            "[audio] monitor stopped: captured_frames={}, dropped_samples={}, mic_frames={}, mic_dropped={}",
            status.captured_frames,
            status.dropped_samples,
            active.microphone_stats.captured_frames.load(Ordering::Relaxed),
            active.microphone_stats.dropped_samples.load(Ordering::Relaxed)
        );
        Ok(status)
    }

    pub fn status(&self) -> Result<AudioStatus, String> {
        let running = self.running.lock().map_err(|_| "audio state poisoned")?;
        Ok(match running.as_ref() {
            Some(active) => active
                .stats
                .snapshot(&active.runtime, &active.microphone_feedback),
            None => AudioStatus::default(),
        })
    }

    /// 前端热更新麦克风混音设置；未运行时也会保存，下次启动生效。
    pub fn set_microphone_settings(
        &self,
        enabled: bool,
        gate: f32,
        gain: f32,
        recalibrate: bool,
    ) -> Result<AudioStatus, String> {
        self.microphone_settings.apply(enabled, gate, gain);
        if recalibrate {
            self.microphone_settings.request_calibration();
        }
        self.status()
    }

    pub fn performance_status(&self) -> Result<DspPerformance, String> {
        let running = self.running.lock().map_err(|_| "audio state poisoned")?;
        Ok(match running.as_ref() {
            Some(active) => active.performance.snapshot(),
            None => DspPerformance::default(),
        })
    }

    pub fn start_ai_pcm(&self, sink: WindowSink) -> Result<AiPcmStatus, String> {
        let running = self.running.lock().map_err(|_| "audio state poisoned")?;
        let active = running
            .as_ref()
            .filter(|active| active.runtime.state() == AudioRuntimeState::Running)
            .ok_or("audio monitor is not running")?;
        Ok(active.ai_pcm.enable(sink))
    }

    pub fn stop_ai_pcm(&self) -> Result<AiPcmStatus, String> {
        let running = self.running.lock().map_err(|_| "audio state poisoned")?;
        Ok(match running.as_ref() {
            Some(active) => active.ai_pcm.disable(),
            None => AiPcmStatus::default(),
        })
    }

    pub fn ai_pcm_status(&self) -> Result<AiPcmStatus, String> {
        let running = self.running.lock().map_err(|_| "audio state poisoned")?;
        Ok(match running.as_ref() {
            Some(active) => active.ai_pcm.status(),
            None => AiPcmStatus::default(),
        })
    }
}

type CaptureProducer = ringbuf::HeapProd<f32>;
type CaptureConsumer = ringbuf::HeapCons<f32>;

fn run_capture(
    mut producer: CaptureProducer,
    stop: &AtomicBool,
    stats: &SharedStats,
    runtime: &SharedRuntime,
    startup: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let result = run_capture_inner(&mut producer, stop, stats, runtime, &startup);
    if let Err(error) = &result {
        let _ = startup.send(Err(error.clone()));
    }
    result
}

fn run_capture_inner(
    producer: &mut CaptureProducer,
    stop: &AtomicBool,
    stats: &SharedStats,
    runtime: &SharedRuntime,
    startup: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    run_device_capture(
        producer,
        stop,
        stats,
        Some(runtime),
        startup,
        Direction::Render,
    )
}

fn run_microphone_capture(
    mut producer: CaptureProducer,
    stop: &AtomicBool,
    stats: &SharedStats,
    startup: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let result = run_device_capture(
        &mut producer,
        stop,
        stats,
        None,
        &startup,
        Direction::Capture,
    );
    if let Err(error) = &result {
        let _ = startup.send(Err(error.clone()));
    }
    result
}

fn run_device_capture(
    producer: &mut CaptureProducer,
    stop: &AtomicBool,
    stats: &SharedStats,
    runtime: Option<&SharedRuntime>,
    startup: &mpsc::SyncSender<Result<(), String>>,
    device_direction: Direction,
) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|error| format!("failed to initialize COM: {error}"))?;

    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let device = enumerator
        .get_default_device(&device_direction)
        .map_err(|error| format!("failed to get default {device_direction:?} device: {error}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("failed to create audio client: {error}"))?;
    let mix_format = audio_client
        .get_mixformat()
        .map_err(|error| format!("failed to read device mix format: {error}"))?;

    let sample_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    mix_format
        .get_subformat()
        .map_err(|error| format!("unsupported device sample format: {error}"))?;
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        sample_rate as usize,
        channels as usize,
        Some(mix_format.get_dwchannelmask()),
    );
    let (default_period, _) = audio_client
        .get_device_period()
        .map_err(|error| format!("failed to get device period: {error}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period,
    };

    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|error| format!("failed to initialize device capture: {error}"))?;
    let event = audio_client
        .set_get_eventhandle()
        .map_err(|error| format!("failed to create WASAPI event: {error}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| format!("failed to create capture client: {error}"))?;
    let buffer_frames = audio_client
        .get_buffer_size()
        .map_err(|error| format!("failed to get capture buffer size: {error}"))?;
    let mut bytes = vec![0_u8; buffer_frames as usize * desired_format.get_blockalign() as usize];
    let mut mono = vec![0.0_f32; buffer_frames as usize];

    stats
        .sample_rate_hz
        .store(sample_rate as u64, Ordering::Relaxed);
    stats.channels.store(channels as u64, Ordering::Relaxed);
    audio_client
        .start_stream()
        .map_err(|error| format!("failed to start device capture: {error}"))?;
    if let Some(runtime) = runtime {
        runtime.set_state(AudioRuntimeState::Running);
    }
    startup
        .send(Ok(()))
        .map_err(|error| format!("audio startup receiver dropped: {error}"))?;

    let mut consecutive_event_timeouts = 0;
    while !stop.load(Ordering::Acquire) {
        if event.wait_for_event(EVENT_WAIT_MILLIS).is_err() {
            consecutive_event_timeouts += 1;
            if consecutive_event_timeouts >= HEALTH_CHECK_TIMEOUTS {
                audio_client.get_current_padding().map_err(|error| {
                    format!("audio device became unavailable while waiting for audio: {error}")
                })?;
                consecutive_event_timeouts = 0;
            }
            continue;
        }
        consecutive_event_timeouts = 0;

        loop {
            let packet_frames = capture_client
                .get_next_packet_size()
                .map_err(|error| format!("failed to query capture packet: {error}"))?;
            if !should_read_capture_packet(stop.load(Ordering::Acquire), packet_frames) {
                break;
            }

            let (frames, _) = capture_client
                .read_from_device(&mut bytes)
                .map_err(|error| format!("failed to read capture packet: {error}"))?;
            let frames = frames as usize;
            if frames == 0 {
                break;
            }
            downmix_f32(&bytes, &mut mono[..frames], channels as usize);
            let written = producer.push_slice(&mono[..frames]);
            if written < frames {
                stats
                    .dropped_samples
                    .fetch_add((frames - written) as u64, Ordering::Relaxed);
            }
            stats
                .captured_frames
                .fetch_add(frames as u64, Ordering::Relaxed);
        }
    }

    audio_client
        .stop_stream()
        .map_err(|error| format!("failed to stop device capture: {error}"))
}

fn should_read_capture_packet(stopping: bool, packet_frames: Option<u32>) -> bool {
    !stopping && packet_frames.is_some_and(|frames| frames > 0)
}

struct DspChannels {
    consumer: CaptureConsumer,
    microphone_consumer: CaptureConsumer,
    microphone_stats: Arc<SharedStats>,
    microphone_feedback: Arc<SharedMicFeedback>,
    ai_producer: CaptureProducer,
    ai_pcm: Arc<SharedAiPcm>,
}

fn run_dsp(
    channels: DspChannels,
    stop: Arc<AtomicBool>,
    stats: Arc<SharedStats>,
    shared_performance: Arc<SharedDspPerformance>,
    runtime: Arc<SharedRuntime>,
    microphone_settings: Arc<MicrophoneSettings>,
    feature_sink: FeatureSink,
    performance_sink: PerformanceSink,
) {
    let DspChannels {
        mut consumer,
        mut microphone_consumer,
        microphone_stats,
        microphone_feedback,
        mut ai_producer,
        ai_pcm,
    } = channels;
    let mut samples = [0.0_f32; 2048];
    let mut microphone_samples = [0.0_f32; 2048];
    let mut microphone_mix = None;
    let mut analyzer = None;
    let mut metrics = None;
    let mut last_report = Instant::now();
    let mut last_feature_event = Instant::now() - FEATURE_EVENT_INTERVAL;
    let mut last_captured_frames = 0;
    let mut observed_capture_drops = 0;

    while !stop.load(Ordering::Acquire) {
        if analyzer.is_none() {
            let sample_rate_hz = stats.sample_rate_hz.load(Ordering::Acquire) as u32;
            if sample_rate_hz > 0 {
                analyzer = Some(FastDsp::new(sample_rate_hz));
                metrics = Some(DspMetrics::new(sample_rate_hz, DSP_HOP_SIZE));
            }
        }

        let mut count = consumer.pop_slice(&mut samples);
        if count == 0 {
            count = microphone_driven_frames(
                microphone_consumer.occupied_len(),
                microphone_stats.sample_rate_hz.load(Ordering::Acquire) as u32,
                stats.sample_rate_hz.load(Ordering::Acquire) as u32,
            )
            .min(samples.len());
            samples[..count].fill(0.0);
        }
        if count == 0 {
            thread::park_timeout(Duration::from_millis(2));
        } else if let (Some(analyzer), Some(metrics)) = (analyzer.as_mut(), metrics.as_mut()) {
            let microphone_rate = microphone_stats.sample_rate_hz.load(Ordering::Acquire) as u32;
            let microphone_enabled = microphone_settings.enabled();
            if microphone_rate > 0 && microphone_mix.is_none() {
                microphone_mix = Some(MicrophoneMix::new(
                    microphone_rate,
                    analyzer.sample_rate_hz,
                    Arc::clone(&microphone_settings),
                ));
            }
            if microphone_rate == 0 {
                microphone_mix = None;
                microphone_consumer.skip(microphone_consumer.occupied_len());
            } else if let Some(mixer) = microphone_mix.as_mut() {
                if microphone_enabled {
                    loop {
                        let mic_count = microphone_consumer.pop_slice(&mut microphone_samples);
                        if mic_count == 0 {
                            break;
                        }
                        mixer.push(&microphone_samples[..mic_count]);
                    }
                    mixer.mix(&mut samples[..count]);
                } else {
                    // 前端关闭了麦克风：丢弃采样不混入，系统音频不受影响
                    microphone_consumer.skip(microphone_consumer.occupied_len());
                }
            }
            let (microphone_level, microphone_gate, microphone_gain) =
                microphone_mix.as_ref().map_or(
                    (0.0, microphone_settings.manual_gate(), 0.0),
                    |mixer| (mixer.input_level(), mixer.current_gate(), mixer.current_gain()),
                );
            microphone_feedback.publish(
                microphone_enabled,
                microphone_level,
                microphone_gate,
                microphone_gain,
            );
            let capture_drops = stats.dropped_samples.load(Ordering::Relaxed);
            if ai_pcm.is_enabled() {
                if capture_drops > observed_capture_drops {
                    ai_pcm.report_discontinuity((capture_drops - observed_capture_drops) as usize);
                }
                if ai_producer.vacant_len() >= count {
                    let written = ai_producer.push_slice(&samples[..count]);
                    debug_assert_eq!(written, count);
                } else {
                    ai_pcm.report_discontinuity(count);
                }
            }
            observed_capture_drops = capture_drops;
            let sample_rate_hz = stats.sample_rate_hz.load(Ordering::Relaxed);
            let pipeline_lag_us = if sample_rate_hz > 0 {
                ((consumer.occupied_len() as u64 * 1_000_000) / sample_rate_hz)
                    .min(u64::from(u32::MAX)) as u32
            } else {
                0
            };
            analyzer.process(&samples[..count], |features, compute_time| {
                stats.publish_features(features);
                if last_feature_event.elapsed() >= FEATURE_EVENT_INTERVAL {
                    feature_sink(features);
                    last_feature_event = Instant::now();
                }
                if let Some(performance) = metrics.record(compute_time, pipeline_lag_us) {
                    shared_performance.publish(performance);
                    performance_sink(performance);
                }
            });
        }

        if cfg!(debug_assertions) && last_report.elapsed() >= Duration::from_secs(1) {
            let snapshot = stats.snapshot(&runtime, &microphone_feedback);
            let frames_per_second = snapshot.captured_frames - last_captured_frames;
            eprintln!(
                "[audio] dsp: frames/s={}, seq={}, rms={:.5}, mic_level={:.5}, bands={:.3}/{:.3}/{:.3}, onset={:.3}, centroid={:.3}, trend={:.3}, silence={}, dropped={}, mic_dropped={}",
                frames_per_second,
                snapshot.sequence,
                snapshot.rms,
                microphone_mix.as_ref().map_or(0.0, MicrophoneMix::input_level),
                snapshot.bass,
                snapshot.mid,
                snapshot.treble,
                snapshot.onset,
                snapshot.centroid,
                snapshot.energy_trend,
                snapshot.silence,
                snapshot.dropped_samples,
                microphone_stats.dropped_samples.load(Ordering::Relaxed)
            );
            last_captured_frames = snapshot.captured_frames;
            last_report = Instant::now();
        }
    }
}

fn microphone_driven_frames(
    microphone_available: usize,
    microphone_rate: u32,
    output_rate: u32,
) -> usize {
    if microphone_rate == 0
        || output_rate == 0
        || microphone_available < microphone_rate as usize / 100
    {
        0
    } else {
        (output_rate / 100) as usize
    }
}

struct FastDsp {
    sample_rate_hz: u32,
    history: Vec<f32>,
    write_index: usize,
    filled: usize,
    samples_since_analysis: usize,
    fft: Arc<dyn RealToComplex<f32>>,
    fft_input: Vec<f32>,
    spectrum: Vec<Complex32>,
    fft_scratch: Vec<Complex32>,
    window: Vec<f32>,
    previous_magnitudes: Vec<f32>,
    previous_rms: f32,
    sequence: u64,
    processed_samples: u64,
}

impl FastDsp {
    fn new(sample_rate_hz: u32) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let spectrum = fft.make_output_vec();
        let fft_scratch = fft.make_scratch_vec();
        let window = (0..FFT_SIZE)
            .map(|index| {
                0.5 - 0.5 * (std::f32::consts::TAU * index as f32 / (FFT_SIZE - 1) as f32).cos()
            })
            .collect();

        Self {
            sample_rate_hz,
            history: vec![0.0; FFT_SIZE],
            write_index: 0,
            filled: 0,
            samples_since_analysis: 0,
            fft,
            fft_input: vec![0.0; FFT_SIZE],
            spectrum,
            fft_scratch,
            window,
            previous_magnitudes: vec![0.0; FFT_SIZE / 2 + 1],
            previous_rms: 0.0,
            sequence: 0,
            processed_samples: 0,
        }
    }

    fn process(&mut self, samples: &[f32], mut publish: impl FnMut(AudioFeatures, Duration)) {
        for &sample in samples {
            self.history[self.write_index] = sample;
            self.write_index = (self.write_index + 1) % FFT_SIZE;
            self.filled = (self.filled + 1).min(FFT_SIZE);
            self.samples_since_analysis += 1;
            self.processed_samples += 1;

            if self.filled == FFT_SIZE && self.samples_since_analysis >= DSP_HOP_SIZE {
                self.samples_since_analysis = 0;
                let started_at = Instant::now();
                let features = self.analyze();
                publish(features, started_at.elapsed());
            }
        }
    }

    fn analyze(&mut self) -> AudioFeatures {
        let mut square_sum = 0.0_f32;
        for index in 0..FFT_SIZE {
            let sample = self.history[(self.write_index + index) % FFT_SIZE];
            square_sum += sample * sample;
            self.fft_input[index] = sample * self.window[index];
        }

        self.fft
            .process_with_scratch(
                &mut self.fft_input,
                &mut self.spectrum,
                &mut self.fft_scratch,
            )
            .expect("FFT buffers have fixed valid lengths");

        let rms = (square_sum / FFT_SIZE as f32).sqrt().clamp(0.0, 1.0);
        let mut bass_energy = 0.0_f32;
        let mut mid_energy = 0.0_f32;
        let mut treble_energy = 0.0_f32;
        let mut magnitude_sum = 0.0_f32;
        let mut weighted_frequency_sum = 0.0_f32;
        let mut positive_flux = 0.0_f32;

        for (bin, (value, previous)) in self
            .spectrum
            .iter()
            .zip(self.previous_magnitudes.iter_mut())
            .enumerate()
            .skip(1)
        {
            let magnitude = value.norm();
            let frequency = bin as f32 * self.sample_rate_hz as f32 / FFT_SIZE as f32;
            let energy = magnitude * magnitude;

            if frequency < 250.0 {
                bass_energy += energy;
            } else if frequency < 4_000.0 {
                mid_energy += energy;
            } else {
                treble_energy += energy;
            }

            magnitude_sum += magnitude;
            weighted_frequency_sum += frequency * magnitude;
            positive_flux += (magnitude - *previous).max(0.0);
            *previous = magnitude;
        }

        let total_energy = bass_energy + mid_energy + treble_energy;
        let (bass, mid, treble) = if total_energy > f32::EPSILON {
            (
                bass_energy / total_energy,
                mid_energy / total_energy,
                treble_energy / total_energy,
            )
        } else {
            (0.0, 0.0, 0.0)
        };
        let onset = if magnitude_sum > f32::EPSILON {
            (positive_flux / magnitude_sum).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let nyquist = self.sample_rate_hz as f32 * 0.5;
        let centroid = if magnitude_sum > f32::EPSILON {
            (weighted_frequency_sum / magnitude_sum / nyquist).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let energy_trend =
            ((rms - self.previous_rms) / self.previous_rms.max(0.01)).clamp(-1.0, 1.0);
        self.previous_rms = rms;
        self.sequence += 1;

        AudioFeatures {
            sequence: self.sequence,
            captured_at_us: self.processed_samples * 1_000_000 / u64::from(self.sample_rate_hz),
            rms,
            bass,
            mid,
            treble,
            onset,
            centroid,
            energy_trend,
            silence: rms < SILENCE_RMS,
        }
    }
}

fn downmix_f32(bytes: &[u8], output: &mut [f32], channels: usize) {
    let frame_bytes = channels * size_of::<f32>();
    for (frame, output_sample) in bytes.chunks_exact(frame_bytes).zip(output.iter_mut()) {
        let sum = frame
            .chunks_exact(size_of::<f32>())
            .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte sample")))
            .sum::<f32>();
        *output_sample = sum / channels as f32;
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    const TEST_SAMPLE_RATE: u32 = 48_000;

    fn sine_wave(frequency_hz: f32, sample_count: usize, amplitude: f32) -> Vec<f32> {
        (0..sample_count)
            .map(|index| {
                let phase =
                    std::f32::consts::TAU * frequency_hz * index as f32 / TEST_SAMPLE_RATE as f32;
                amplitude * phase.sin()
            })
            .collect()
    }

    fn analyze(samples: &[f32]) -> Vec<AudioFeatures> {
        let mut analyzer = FastDsp::new(TEST_SAMPLE_RATE);
        let mut features = Vec::new();
        analyzer.process(samples, |snapshot, _| features.push(snapshot));
        features
    }

    #[test]
    fn capture_packet_loop_stops_for_shutdown_and_empty_packets() {
        assert!(!should_read_capture_packet(true, Some(128)));
        assert!(!should_read_capture_packet(false, Some(0)));
        assert!(!should_read_capture_packet(false, None));
        assert!(should_read_capture_packet(false, Some(128)));
    }

    #[test]
    fn microphone_drives_dsp_without_loopback_packets() {
        assert_eq!(microphone_driven_frames(480, 48_000, 48_000), 480);
        assert_eq!(microphone_driven_frames(441, 44_100, 48_000), 480);
        assert_eq!(microphone_driven_frames(100, 48_000, 48_000), 0);
        assert_eq!(microphone_driven_frames(480, 0, 48_000), 0);
    }

    #[test]
    fn classifies_frequency_bands_and_centroid() {
        let cases = [
            (100.0, 0, 100.0 / 24_000.0),
            (1_000.0, 1, 1_000.0 / 24_000.0),
            (8_000.0, 2, 8_000.0 / 24_000.0),
        ];

        for (frequency_hz, expected_band, expected_centroid) in cases {
            let signal = sine_wave(frequency_hz, FFT_SIZE + DSP_HOP_SIZE * 3, 0.5);
            let snapshots = analyze(&signal);
            let snapshot = snapshots.last().expect("signal should produce features");
            let bands = [snapshot.bass, snapshot.mid, snapshot.treble];

            assert!(
                bands[expected_band] > 0.9,
                "{frequency_hz} Hz produced bands {bands:?}"
            );
            assert!(
                (snapshot.centroid - expected_centroid).abs() < 0.02,
                "{frequency_hz} Hz produced centroid {}",
                snapshot.centroid
            );
        }
    }

    #[test]
    fn detects_silence_and_sudden_onset() {
        let mut analyzer = FastDsp::new(TEST_SAMPLE_RATE);
        let mut snapshots = Vec::new();
        analyzer.process(&vec![0.0; FFT_SIZE + DSP_HOP_SIZE], |snapshot, _| {
            snapshots.push(snapshot)
        });
        assert!(snapshots.last().expect("silence snapshot").silence);

        let burst = sine_wave(1_000.0, DSP_HOP_SIZE, 0.8);
        analyzer.process(&burst, |snapshot, _| snapshots.push(snapshot));
        let snapshot = snapshots.last().expect("burst snapshot");

        assert!(!snapshot.silence);
        assert!(snapshot.onset > 0.5, "onset was {}", snapshot.onset);
        assert!(snapshot.sequence >= 2);
        assert!(snapshot.captured_at_us > 0);
    }

    #[test]
    fn runtime_failure_is_visible_in_status() {
        let stats = SharedStats::default();
        let runtime = SharedRuntime::new();
        let mic = SharedMicFeedback::default();
        assert_eq!(
            stats.snapshot(&runtime, &mic).state,
            AudioRuntimeState::Starting
        );

        runtime.set_state(AudioRuntimeState::Running);
        assert!(stats.snapshot(&runtime, &mic).running);

        runtime.fail("device invalidated".into());
        let status = stats.snapshot(&runtime, &mic);
        assert!(!status.running);
        assert_eq!(status.state, AudioRuntimeState::Failed);
        assert_eq!(status.last_error.as_deref(), Some("device invalidated"));
    }

    #[test]
    #[ignore = "requires a Windows default render device"]
    fn starts_and_stops_default_render_device() {
        let monitor = AudioMonitor::default();
        let started = monitor
            .start(Arc::new(|_| {}), Arc::new(|_| {}))
            .expect("WASAPI monitor should start");
        assert!(started.running);
        assert!(started.sample_rate_hz > 0);
        assert!(started.channels > 0);

        thread::sleep(Duration::from_millis(250));

        let running = monitor.status().expect("audio status should be available");
        assert!(running.running);

        let stopped = monitor.stop().expect("WASAPI monitor should stop");
        assert!(!stopped.running);
    }
}

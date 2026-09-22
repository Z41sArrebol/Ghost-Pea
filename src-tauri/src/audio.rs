use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use ringbuf::{traits::*, HeapRb};
use serde::Serialize;
use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

const CAPTURE_BUFFER_MILLIS: usize = 250;
const EVENT_WAIT_MILLIS: u32 = 50;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub running: bool,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub captured_frames: u64,
    pub dropped_samples: u64,
    pub rms: f32,
}

#[derive(Default)]
struct SharedStats {
    sample_rate_hz: AtomicU64,
    channels: AtomicU64,
    captured_frames: AtomicU64,
    dropped_samples: AtomicU64,
    rms_bits: AtomicU64,
}

impl SharedStats {
    fn snapshot(&self, running: bool) -> AudioStatus {
        AudioStatus {
            running,
            sample_rate_hz: self.sample_rate_hz.load(Ordering::Relaxed) as u32,
            channels: self.channels.load(Ordering::Relaxed) as u16,
            captured_frames: self.captured_frames.load(Ordering::Relaxed),
            dropped_samples: self.dropped_samples.load(Ordering::Relaxed),
            rms: f64::from_bits(self.rms_bits.load(Ordering::Relaxed)) as f32,
        }
    }
}

struct RunningAudio {
    stop: Arc<AtomicBool>,
    capture_thread: JoinHandle<()>,
    dsp_thread: JoinHandle<()>,
    stats: Arc<SharedStats>,
}

#[derive(Default)]
pub struct AudioMonitor {
    running: Mutex<Option<RunningAudio>>,
}

impl AudioMonitor {
    pub fn start(&self) -> Result<AudioStatus, String> {
        let mut running = self.running.lock().map_err(|_| "audio state poisoned")?;
        if let Some(active) = running.as_ref() {
            return Ok(active.stats.snapshot(true));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(SharedStats::default());
        let capacity = 48_000 * CAPTURE_BUFFER_MILLIS / 1_000;
        let ring = HeapRb::<f32>::new(capacity);
        let (producer, consumer) = ring.split();

        let dsp_stop = Arc::clone(&stop);
        let dsp_stats = Arc::clone(&stats);
        let dsp_thread = thread::Builder::new()
            .name("ghost-pea-dsp".into())
            .spawn(move || run_dsp(consumer, dsp_stop, dsp_stats))
            .map_err(|error| format!("failed to spawn DSP thread: {error}"))?;

        let capture_stop = Arc::clone(&stop);
        let capture_stats = Arc::clone(&stats);
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let capture_thread = match thread::Builder::new()
            .name("ghost-pea-wasapi".into())
            .spawn(move || {
                if let Err(error) = run_capture(producer, &capture_stop, &capture_stats, startup_tx)
                {
                    capture_stop.store(true, Ordering::Release);
                    eprintln!("WASAPI capture stopped: {error}");
                }
            }) {
            Ok(handle) => handle,
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = dsp_thread.join();
                return Err(format!("failed to spawn WASAPI thread: {error}"));
            }
        };

        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                let status = stats.snapshot(true);
                eprintln!(
                    "[audio] monitor started: {} Hz, {} channels",
                    status.sample_rate_hz, status.channels
                );
                *running = Some(RunningAudio {
                    stop,
                    capture_thread,
                    dsp_thread,
                    stats,
                });
                Ok(status)
            }
            Ok(Err(error)) => {
                stop.store(true, Ordering::Release);
                let _ = capture_thread.join();
                let _ = dsp_thread.join();
                Err(error)
            }
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = capture_thread.join();
                let _ = dsp_thread.join();
                Err(format!("WASAPI startup timed out: {error}"))
            }
        }
    }

    pub fn stop(&self) -> Result<AudioStatus, String> {
        let active = self
            .running
            .lock()
            .map_err(|_| "audio state poisoned")?
            .take();

        let Some(active) = active else {
            return Ok(AudioStatus::default());
        };

        active.stop.store(true, Ordering::Release);
        active
            .capture_thread
            .join()
            .map_err(|_| "WASAPI thread panicked")?;
        active
            .dsp_thread
            .join()
            .map_err(|_| "DSP thread panicked")?;
        let status = active.stats.snapshot(false);
        eprintln!(
            "[audio] monitor stopped: captured_frames={}, dropped_samples={}",
            status.captured_frames, status.dropped_samples
        );
        Ok(status)
    }

    pub fn status(&self) -> Result<AudioStatus, String> {
        let running = self.running.lock().map_err(|_| "audio state poisoned")?;
        Ok(match running.as_ref() {
            Some(active) => active.stats.snapshot(true),
            None => AudioStatus::default(),
        })
    }
}

type CaptureProducer = ringbuf::HeapProd<f32>;
type CaptureConsumer = ringbuf::HeapCons<f32>;

fn run_capture(
    mut producer: CaptureProducer,
    stop: &AtomicBool,
    stats: &SharedStats,
    startup: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let result = run_capture_inner(&mut producer, stop, stats, &startup);
    if let Err(error) = &result {
        let _ = startup.send(Err(error.clone()));
    }
    result
}

fn run_capture_inner(
    producer: &mut CaptureProducer,
    stop: &AtomicBool,
    stats: &SharedStats,
    startup: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|error| format!("failed to initialize COM: {error}"))?;

    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|error| format!("failed to get default output device: {error}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("failed to create audio client: {error}"))?;
    let mix_format = audio_client
        .get_mixformat()
        .map_err(|error| format!("failed to read output mix format: {error}"))?;

    let sample_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    mix_format
        .get_subformat()
        .map_err(|error| format!("unsupported output sample format: {error}"))?;
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
        .map_err(|error| format!("failed to get output device period: {error}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period,
    };

    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|error| format!("failed to initialize loopback capture: {error}"))?;
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
        .map_err(|error| format!("failed to start loopback capture: {error}"))?;
    startup
        .send(Ok(()))
        .map_err(|error| format!("audio startup receiver dropped: {error}"))?;

    while !stop.load(Ordering::Acquire) {
        if event.wait_for_event(EVENT_WAIT_MILLIS).is_err() {
            continue;
        }

        while capture_client
            .get_next_packet_size()
            .map_err(|error| format!("failed to query capture packet: {error}"))?
            .is_some()
        {
            let (frames, _) = capture_client
                .read_from_device(&mut bytes)
                .map_err(|error| format!("failed to read loopback packet: {error}"))?;
            let frames = frames as usize;
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
        .map_err(|error| format!("failed to stop loopback capture: {error}"))
}

fn run_dsp(mut consumer: CaptureConsumer, stop: Arc<AtomicBool>, stats: Arc<SharedStats>) {
    let mut samples = [0.0_f32; 2048];
    let mut last_report = Instant::now();
    let mut last_captured_frames = 0;

    while !stop.load(Ordering::Acquire) {
        let count = consumer.pop_slice(&mut samples);
        if count == 0 {
            thread::park_timeout(Duration::from_millis(2));
        } else {
            let square_sum = samples[..count]
                .iter()
                .map(|sample| f64::from(*sample) * f64::from(*sample))
                .sum::<f64>();
            let rms = (square_sum / count as f64).sqrt();
            stats.rms_bits.store(rms.to_bits(), Ordering::Relaxed);
        }

        if cfg!(debug_assertions) && last_report.elapsed() >= Duration::from_secs(1) {
            let snapshot = stats.snapshot(true);
            let frames_per_second = snapshot.captured_frames - last_captured_frames;
            eprintln!(
                "[audio] pcm: frames/s={}, total={}, rms={:.5}, dropped={}",
                frames_per_second, snapshot.captured_frames, snapshot.rms, snapshot.dropped_samples
            );
            last_captured_frames = snapshot.captured_frames;
            last_report = Instant::now();
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

    #[test]
    #[ignore = "requires a Windows default render device"]
    fn starts_and_stops_default_render_device() {
        let monitor = AudioMonitor::default();
        let started = monitor.start().expect("WASAPI monitor should start");
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

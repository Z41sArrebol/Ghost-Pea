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

const CAPTURE_BUFFER_MILLIS: usize = 250;
const EVENT_WAIT_MILLIS: u32 = 50;
const FFT_SIZE: usize = 2048;
const DSP_HOP_SIZE: usize = 512;
const FEATURE_EVENT_INTERVAL: Duration = Duration::from_micros(16_667);
const SILENCE_RMS: f32 = 0.001;

pub type FeatureSink = Arc<dyn Fn(AudioFeatures) + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub running: bool,
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
    fn snapshot(&self, running: bool) -> AudioStatus {
        AudioStatus {
            running,
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
    capture_thread: JoinHandle<()>,
    dsp_thread: JoinHandle<()>,
    stats: Arc<SharedStats>,
}

#[derive(Default)]
pub struct AudioMonitor {
    running: Mutex<Option<RunningAudio>>,
}

impl AudioMonitor {
    pub fn start(&self, feature_sink: FeatureSink) -> Result<AudioStatus, String> {
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
            .spawn(move || run_dsp(consumer, dsp_stop, dsp_stats, feature_sink))
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

fn run_dsp(
    mut consumer: CaptureConsumer,
    stop: Arc<AtomicBool>,
    stats: Arc<SharedStats>,
    feature_sink: FeatureSink,
) {
    let mut samples = [0.0_f32; 2048];
    let mut analyzer = None;
    let mut last_report = Instant::now();
    let mut last_feature_event = Instant::now() - FEATURE_EVENT_INTERVAL;
    let mut last_captured_frames = 0;

    while !stop.load(Ordering::Acquire) {
        if analyzer.is_none() {
            let sample_rate_hz = stats.sample_rate_hz.load(Ordering::Acquire) as u32;
            if sample_rate_hz > 0 {
                analyzer = Some(FastDsp::new(sample_rate_hz));
            }
        }

        let count = consumer.pop_slice(&mut samples);
        if count == 0 {
            thread::park_timeout(Duration::from_millis(2));
        } else if let Some(analyzer) = analyzer.as_mut() {
            analyzer.process(&samples[..count], |features| {
                stats.publish_features(features);
                if last_feature_event.elapsed() >= FEATURE_EVENT_INTERVAL {
                    feature_sink(features);
                    last_feature_event = Instant::now();
                }
            });
        }

        if cfg!(debug_assertions) && last_report.elapsed() >= Duration::from_secs(1) {
            let snapshot = stats.snapshot(true);
            let frames_per_second = snapshot.captured_frames - last_captured_frames;
            eprintln!(
                "[audio] dsp: frames/s={}, seq={}, rms={:.5}, bands={:.3}/{:.3}/{:.3}, onset={:.3}, centroid={:.3}, trend={:.3}, silence={}, dropped={}",
                frames_per_second,
                snapshot.sequence,
                snapshot.rms,
                snapshot.bass,
                snapshot.mid,
                snapshot.treble,
                snapshot.onset,
                snapshot.centroid,
                snapshot.energy_trend,
                snapshot.silence,
                snapshot.dropped_samples
            );
            last_captured_frames = snapshot.captured_frames;
            last_report = Instant::now();
        }
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

    fn process(&mut self, samples: &[f32], mut publish: impl FnMut(AudioFeatures)) {
        for &sample in samples {
            self.history[self.write_index] = sample;
            self.write_index = (self.write_index + 1) % FFT_SIZE;
            self.filled = (self.filled + 1).min(FFT_SIZE);
            self.samples_since_analysis += 1;
            self.processed_samples += 1;

            if self.filled == FFT_SIZE && self.samples_since_analysis >= DSP_HOP_SIZE {
                self.samples_since_analysis = 0;
                publish(self.analyze());
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
        analyzer.process(samples, |snapshot| features.push(snapshot));
        features
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
        analyzer.process(&vec![0.0; FFT_SIZE + DSP_HOP_SIZE], |snapshot| {
            snapshots.push(snapshot)
        });
        assert!(snapshots.last().expect("silence snapshot").silence);

        let burst = sine_wave(1_000.0, DSP_HOP_SIZE, 0.8);
        analyzer.process(&burst, |snapshot| snapshots.push(snapshot));
        let snapshot = snapshots.last().expect("burst snapshot");

        assert!(!snapshot.silence);
        assert!(snapshot.onset > 0.5, "onset was {}", snapshot.onset);
        assert!(snapshot.sequence >= 2);
        assert!(snapshot.captured_at_us > 0);
    }

    #[test]
    #[ignore = "requires a Windows default render device"]
    fn starts_and_stops_default_render_device() {
        let monitor = AudioMonitor::default();
        let started = monitor
            .start(Arc::new(|_| {}))
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

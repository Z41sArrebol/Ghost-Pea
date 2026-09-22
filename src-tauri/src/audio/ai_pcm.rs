use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use ringbuf::traits::*;
use rubato::{audioadapter_buffers::direct::InterleavedSlice, Fft, FixedSync, Resampler};
use serde::Serialize;

use super::SharedStats;

pub const OUTPUT_SAMPLE_RATE_HZ: u32 = 16_000;
pub const WINDOW_SAMPLES: usize = OUTPUT_SAMPLE_RATE_HZ as usize * 3;
pub const HOP_SAMPLES: usize = OUTPUT_SAMPLE_RATE_HZ as usize;
pub const RING_BUFFER_MILLIS: usize = 1_000;
const INPUT_CHUNK_FRAMES: usize = 480;
const PAYLOAD_HEADER_BYTES: usize = 32;
const PAYLOAD_VERSION: u32 = 1;

pub type WindowSink = Arc<dyn Fn(Vec<u8>) -> Result<(), String> + Send + Sync + 'static>;
pub type AiConsumer = ringbuf::HeapCons<f32>;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPcmStatus {
    pub enabled: bool,
    pub output_sample_rate_hz: u32,
    pub window_samples: u32,
    pub hop_samples: u32,
    pub stream_epoch: u64,
    pub sequence: u64,
    pub emitted_windows: u64,
    pub dropped_input_samples: u64,
    pub buffered_input_samples: u64,
    pub last_error: Option<String>,
}

pub struct SharedAiPcm {
    enabled: AtomicBool,
    stream_epoch: AtomicU64,
    sequence: AtomicU64,
    emitted_windows: AtomicU64,
    dropped_input_samples: AtomicU64,
    buffered_input_samples: AtomicU64,
    sink: Mutex<Option<WindowSink>>,
    last_error: Mutex<Option<String>>,
}

impl Default for SharedAiPcm {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            stream_epoch: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
            emitted_windows: AtomicU64::new(0),
            dropped_input_samples: AtomicU64::new(0),
            buffered_input_samples: AtomicU64::new(0),
            sink: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }
}

impl SharedAiPcm {
    pub fn enable(&self, sink: WindowSink) -> AiPcmStatus {
        *self.sink.lock().unwrap_or_else(|value| value.into_inner()) = Some(sink);
        *self
            .last_error
            .lock()
            .unwrap_or_else(|value| value.into_inner()) = None;
        self.sequence.store(0, Ordering::Relaxed);
        self.buffered_input_samples.store(0, Ordering::Relaxed);
        self.stream_epoch.fetch_add(1, Ordering::AcqRel);
        self.enabled.store(true, Ordering::Release);
        self.status()
    }

    pub fn disable(&self) -> AiPcmStatus {
        self.enabled.store(false, Ordering::Release);
        self.stream_epoch.fetch_add(1, Ordering::AcqRel);
        self.buffered_input_samples.store(0, Ordering::Relaxed);
        *self.sink.lock().unwrap_or_else(|value| value.into_inner()) = None;
        self.status()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn report_discontinuity(&self, dropped_samples: usize) {
        self.dropped_input_samples
            .fetch_add(dropped_samples as u64, Ordering::Relaxed);
        self.stream_epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub fn status(&self) -> AiPcmStatus {
        AiPcmStatus {
            enabled: self.is_enabled(),
            output_sample_rate_hz: OUTPUT_SAMPLE_RATE_HZ,
            window_samples: WINDOW_SAMPLES as u32,
            hop_samples: HOP_SAMPLES as u32,
            stream_epoch: self.stream_epoch.load(Ordering::Acquire),
            sequence: self.sequence.load(Ordering::Acquire),
            emitted_windows: self.emitted_windows.load(Ordering::Relaxed),
            dropped_input_samples: self.dropped_input_samples.load(Ordering::Relaxed),
            buffered_input_samples: self.buffered_input_samples.load(Ordering::Relaxed),
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .clone(),
        }
    }

    fn sink(&self) -> Option<WindowSink> {
        self.sink
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    }

    fn fail_sink(&self, error: String) {
        *self
            .last_error
            .lock()
            .unwrap_or_else(|value| value.into_inner()) = Some(error);
        self.enabled.store(false, Ordering::Release);
        self.stream_epoch.fetch_add(1, Ordering::AcqRel);
        *self.sink.lock().unwrap_or_else(|value| value.into_inner()) = None;
    }
}

struct AiPcmProcessor {
    resampler: Fft<f32>,
    input_frames: usize,
    window: VecDeque<f32>,
}

impl AiPcmProcessor {
    fn new(input_sample_rate_hz: u32) -> Result<Self, String> {
        let resampler = Fft::<f32>::new(
            input_sample_rate_hz as usize,
            OUTPUT_SAMPLE_RATE_HZ as usize,
            INPUT_CHUNK_FRAMES,
            1,
            FixedSync::Input,
        )
        .map_err(|error| format!("failed to create AI PCM resampler: {error}"))?;
        let input_frames = resampler.input_frames_next();
        Ok(Self {
            resampler,
            input_frames,
            window: VecDeque::with_capacity(WINDOW_SAMPLES + HOP_SAMPLES),
        })
    }

    fn reset(&mut self) {
        self.resampler.reset();
        self.window.clear();
    }

    fn process(&mut self, input: &[f32], mut publish: impl FnMut(&[f32])) -> Result<(), String> {
        let input = InterleavedSlice::new(input, 1, input.len())
            .map_err(|error| format!("invalid AI PCM input buffer: {error}"))?;
        let output = self
            .resampler
            .process(&input, None)
            .map_err(|error| format!("failed to resample AI PCM: {error}"))?
            .take_data();
        self.window.extend(output);

        while self.window.len() >= WINDOW_SAMPLES {
            let contiguous = self.window.make_contiguous();
            publish(&contiguous[..WINDOW_SAMPLES]);
            self.window.drain(..HOP_SAMPLES);
        }
        Ok(())
    }
}

pub fn run(
    mut consumer: AiConsumer,
    stop: Arc<AtomicBool>,
    stats: Arc<SharedStats>,
    shared: Arc<SharedAiPcm>,
) {
    let mut processor: Option<AiPcmProcessor> = None;
    let mut input = Vec::new();
    let mut observed_epoch = shared.stream_epoch.load(Ordering::Acquire);

    while !stop.load(Ordering::Acquire) {
        let epoch = shared.stream_epoch.load(Ordering::Acquire);
        if epoch != observed_epoch || !shared.is_enabled() {
            observed_epoch = epoch;
            consumer.skip(consumer.occupied_len());
            if let Some(processor) = processor.as_mut() {
                processor.reset();
            }
            shared.buffered_input_samples.store(0, Ordering::Relaxed);
            thread::park_timeout(Duration::from_millis(5));
            continue;
        }

        if processor.is_none() {
            let sample_rate_hz = stats.sample_rate_hz.load(Ordering::Acquire) as u32;
            if sample_rate_hz == 0 {
                thread::park_timeout(Duration::from_millis(2));
                continue;
            }
            match AiPcmProcessor::new(sample_rate_hz) {
                Ok(value) => {
                    input.resize(value.input_frames, 0.0);
                    processor = Some(value);
                }
                Err(error) => {
                    shared.fail_sink(error);
                    continue;
                }
            }
        }

        if consumer.occupied_len() < input.len() {
            shared
                .buffered_input_samples
                .store(consumer.occupied_len() as u64, Ordering::Relaxed);
            thread::park_timeout(Duration::from_millis(2));
            continue;
        }

        let count = consumer.pop_slice(&mut input);
        debug_assert_eq!(count, input.len());
        let result = processor
            .as_mut()
            .expect("processor initialized above")
            .process(&input, |window| {
                let sequence = shared.sequence.fetch_add(1, Ordering::AcqRel) + 1;
                if let Some(sink) = shared.sink() {
                    let payload = encode_window(observed_epoch, sequence, window);
                    match sink(payload) {
                        Ok(()) => {
                            shared.emitted_windows.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => shared.fail_sink(error),
                    }
                }
            });
        if let Err(error) = result {
            shared.fail_sink(error);
        }
        shared
            .buffered_input_samples
            .store(consumer.occupied_len() as u64, Ordering::Relaxed);
    }
}

fn encode_window(stream_epoch: u64, sequence: u64, samples: &[f32]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(PAYLOAD_HEADER_BYTES + samples.len() * size_of::<f32>());
    payload.extend_from_slice(&PAYLOAD_VERSION.to_le_bytes());
    payload.extend_from_slice(&OUTPUT_SAMPLE_RATE_HZ.to_le_bytes());
    payload.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    payload.extend_from_slice(&0_u32.to_le_bytes());
    payload.extend_from_slice(&stream_epoch.to_le_bytes());
    payload.extend_from_slice(&sequence.to_le_bytes());
    for sample in samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_wave(sample_rate_hz: u32, seconds: usize) -> Vec<f32> {
        (0..sample_rate_hz as usize * seconds)
            .map(|index| {
                (std::f32::consts::TAU * 440.0 * index as f32 / sample_rate_hz as f32).sin()
            })
            .collect()
    }

    #[test]
    fn resamples_and_emits_three_second_windows_every_second() {
        let mut processor = AiPcmProcessor::new(48_000).unwrap();
        let input = sine_wave(48_000, 5);
        let mut windows = Vec::new();
        for chunk in input.chunks_exact(processor.input_frames) {
            processor
                .process(chunk, |window| windows.push(window.to_vec()))
                .unwrap();
        }

        assert_eq!(windows.len(), 3);
        assert!(windows.iter().all(|window| window.len() == WINDOW_SAMPLES));
    }

    #[test]
    fn reset_discards_partial_window() {
        let mut processor = AiPcmProcessor::new(44_100).unwrap();
        let input = sine_wave(44_100, 2);
        for chunk in input.chunks_exact(processor.input_frames) {
            processor
                .process(chunk, |_| panic!("window emitted early"))
                .unwrap();
        }
        processor.reset();

        let mut emitted = 0;
        for chunk in input.chunks_exact(processor.input_frames) {
            processor.process(chunk, |_| emitted += 1).unwrap();
        }
        assert_eq!(emitted, 0);
    }

    #[test]
    fn binary_payload_has_header_and_little_endian_pcm() {
        let payload = encode_window(7, 9, &[0.25, -0.5]);
        assert_eq!(payload.len(), PAYLOAD_HEADER_BYTES + 8);
        assert_eq!(u32::from_le_bytes(payload[0..4].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(payload[4..8].try_into().unwrap()),
            16_000
        );
        assert_eq!(u32::from_le_bytes(payload[8..12].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(payload[16..24].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(payload[24..32].try_into().unwrap()), 9);
        assert_eq!(
            f32::from_le_bytes(payload[32..36].try_into().unwrap()),
            0.25
        );
        assert_eq!(
            f32::from_le_bytes(payload[36..40].try_into().unwrap()),
            -0.5
        );
    }

    #[test]
    fn discontinuity_advances_epoch_and_counts_dropped_samples() {
        let shared = SharedAiPcm::default();
        shared.report_discontinuity(37);

        let status = shared.status();
        assert_eq!(status.stream_epoch, 1);
        assert_eq!(status.dropped_input_samples, 37);
    }
}

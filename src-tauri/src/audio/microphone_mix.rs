use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};

const MAX_BUFFER_MILLIS: usize = 250;
const TARGET_BUFFER_MILLIS: usize = 20;
const MIC_GAIN: f32 = 1.0;
const NOISE_GATE_RATIO: f32 = 2.5;
const MIN_NOISE_GATE: f32 = 0.008;
const MIN_MIC_GAIN: f32 = 0.15;
const CALIBRATION_SECONDS: usize = 2;

/// 前端可调的手动门限上限，与自动校准的上限保持一致。
pub const MAX_MANUAL_GATE: f32 = 0.2;

/// 麦克风混音设置：由前端热更新，改完立即生效，不需要重启采集。
#[derive(Debug)]
pub struct MicrophoneSettings {
    enabled: AtomicBool,
    gate: AtomicU32,
    gain: AtomicU32,
    calibration: AtomicU64,
}

impl Default for MicrophoneSettings {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            gate: AtomicU32::new(0.0_f32.to_bits()),
            gain: AtomicU32::new(1.0_f32.to_bits()),
            calibration: AtomicU64::new(0),
        }
    }
}

impl MicrophoneSettings {
    /// `gate = 0` 表示使用自动校准的底噪。
    pub fn apply(&self, enabled: bool, gate: f32, gain: f32) {
        self.enabled.store(enabled, Ordering::Release);
        self.gate
            .store(gate.clamp(0.0, MAX_MANUAL_GATE).to_bits(), Ordering::Release);
        self.gain
            .store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    }

    /// 请求重新做一次底噪校准，下一次 `mix` 时生效。
    pub fn request_calibration(&self) {
        self.calibration.fetch_add(1, Ordering::AcqRel);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn manual_gate(&self) -> f32 {
        f32::from_bits(self.gate.load(Ordering::Acquire))
    }

    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Acquire))
    }

    fn calibration_generation(&self) -> u64 {
        self.calibration.load(Ordering::Acquire)
    }
}

pub struct MicrophoneMix {
    input_rate: u32,
    output_rate: u32,
    samples: VecDeque<f32>,
    phase: f64,
    noise_floor: f32,
    calibration_sum: f64,
    calibration_samples: usize,
    envelope: f32,
    gain: f32,
    settings: Arc<MicrophoneSettings>,
    calibration_generation: u64,
}

impl MicrophoneMix {
    pub fn new(input_rate: u32, output_rate: u32, settings: Arc<MicrophoneSettings>) -> Self {
        Self {
            input_rate,
            output_rate,
            samples: VecDeque::with_capacity(input_rate as usize / 4),
            phase: 0.0,
            noise_floor: MIN_NOISE_GATE,
            calibration_sum: 0.0,
            calibration_samples: 0,
            envelope: 0.0,
            gain: 0.0,
            settings,
            calibration_generation: 0,
        }
    }

    pub fn push(&mut self, input: &[f32]) {
        self.samples.extend(input);
        let max_len = self.input_rate as usize * MAX_BUFFER_MILLIS / 1_000;
        if self.samples.len() > max_len {
            self.samples.drain(..self.samples.len() - max_len);
            self.phase = 0.0;
        }
    }

    pub fn input_level(&self) -> f32 {
        self.envelope
    }

    /// 当前生效的底噪门限：手动设置为准，否则用校准值。
    pub fn current_gate(&self) -> f32 {
        let manual = self.settings.manual_gate();
        if manual > 0.0 {
            manual
        } else {
            self.noise_floor
        }
    }

    /// 当前门限增益，等于 `MIN_MIC_GAIN` 时表示信号被压住。
    pub fn current_gain(&self) -> f32 {
        self.gain
    }

    fn restart_calibration(&mut self) {
        self.calibration_generation = self.settings.calibration_generation();
        self.calibration_sum = 0.0;
        self.calibration_samples = 0;
        self.envelope = 0.0;
        self.gain = 0.0;
        self.noise_floor = MIN_NOISE_GATE;
    }

    pub fn mix(&mut self, output: &mut [f32]) {
        if self.calibration_generation != self.settings.calibration_generation() {
            self.restart_calibration();
        }
        let mix_gain = self.settings.gain();
        let manual_gate = self.settings.manual_gate();
        let gate = if manual_gate > 0.0 {
            manual_gate
        } else {
            self.noise_floor
        };
        let target_len = self.input_rate as usize * TARGET_BUFFER_MILLIS / 1_000;
        let adjustment = if self.samples.len() > target_len * 2 {
            1.002
        } else {
            1.0
        };
        let step = self.input_rate as f64 / self.output_rate as f64 * adjustment;
        let calibration_target = self.output_rate as usize * CALIBRATION_SECONDS;
        for sample in output {
            let index = self.phase as usize;
            if self.samples.len() <= index + 1 {
                self.gain *= 0.995;
                continue;
            }
            let fraction = (self.phase - index as f64) as f32;
            let microphone =
                self.samples[index] * (1.0 - fraction) + self.samples[index + 1] * fraction;
            self.envelope = self.envelope * 0.999 + microphone.abs() * 0.001;
            if self.calibration_samples < calibration_target {
                self.calibration_sum += (microphone * microphone) as f64;
                self.calibration_samples += 1;
                *sample = (*sample + microphone * MIN_MIC_GAIN * MIC_GAIN * mix_gain)
                    .clamp(-1.0, 1.0);
                if self.calibration_samples == calibration_target {
                    self.noise_floor = ((self.calibration_sum / self.calibration_samples as f64)
                        .sqrt() as f32
                        * NOISE_GATE_RATIO)
                        .clamp(MIN_NOISE_GATE, MAX_MANUAL_GATE);
                }
            } else {
                let target =
                    ((self.envelope / gate - 0.4) / 0.8).clamp(MIN_MIC_GAIN, 1.0);
                self.gain += (target - self.gain) * if target > self.gain { 0.002 } else { 0.0002 };
                *sample =
                    (*sample + microphone * self.gain * MIC_GAIN * mix_gain).clamp(-1.0, 1.0);
            }
            self.phase += step;
            let consumed = self.phase as usize;
            if consumed > 0 {
                self.samples.drain(..consumed.min(self.samples.len()));
                self.phase -= consumed as f64;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> Arc<MicrophoneSettings> {
        Arc::new(MicrophoneSettings::default())
    }

    #[test]
    fn missing_microphone_does_not_block_system_audio() {
        let mut mixer = MicrophoneMix::new(44_100, 48_000, default_settings());
        let mut output = [0.25; 480];
        mixer.mix(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.25));
    }

    #[test]
    fn calibrated_voice_contributes_at_different_sample_rates() {
        let mut mixer = MicrophoneMix::new(44_100, 48_000, default_settings());
        for _ in 0..201 {
            mixer.push(&[0.001; 441]);
            mixer.mix(&mut [0.0; 480]);
        }
        let mut output = [0.0; 480];
        for _ in 0..8 {
            mixer.push(&[0.4; 441]);
            mixer.mix(&mut output);
        }
        assert!(output.iter().any(|sample| *sample > 0.01));
    }

    #[test]
    fn voice_above_room_noise_changes_mixed_rms() {
        let mut mixer = MicrophoneMix::new(48_000, 48_000, default_settings());
        for _ in 0..201 {
            mixer.push(&[0.01; 480]);
            mixer.mix(&mut [0.0; 480]);
        }
        let mut output = [0.0; 480];
        for _ in 0..20 {
            mixer.push(&[0.02; 480]);
            mixer.mix(&mut output);
        }
        assert!(output.iter().any(|sample| *sample > 0.002));
    }

    #[test]
    fn zero_gain_keeps_system_audio_untouched() {
        let settings = default_settings();
        settings.apply(true, 0.0, 0.0);
        let mut mixer = MicrophoneMix::new(48_000, 48_000, Arc::clone(&settings));
        for _ in 0..201 {
            mixer.push(&[0.4; 480]);
            mixer.mix(&mut [0.0; 480]);
        }
        let mut output = [0.25; 480];
        for _ in 0..20 {
            mixer.push(&[0.4; 480]);
            mixer.mix(&mut output);
        }
        assert!(output.iter().all(|sample| (*sample - 0.25).abs() < 1e-6));
    }

    #[test]
    fn manual_gate_suppresses_quiet_input() {
        let settings = default_settings();
        let mut mixer = MicrophoneMix::new(48_000, 48_000, Arc::clone(&settings));
        for _ in 0..201 {
            mixer.push(&[0.001; 480]);
            mixer.mix(&mut [0.0; 480]);
        }
        // 校准之后手动抬高门限：远低于门限的声音应被压到最小增益
        settings.apply(true, 0.06, 1.0);
        let mut peak = 0.0_f32;
        for _ in 0..200 {
            mixer.push(&[0.01; 480]);
            let mut output = [0.0; 480];
            mixer.mix(&mut output);
            peak = output
                .iter()
                .fold(peak, |acc, sample| acc.max(sample.abs()));
        }
        assert!(
            peak < 0.004,
            "manual gate should attenuate quiet input: {peak}"
        );
        assert!(mixer.current_gate() > 0.05);
    }

    #[test]
    fn recalibration_replaces_the_automatic_gate() {
        let settings = default_settings();
        let mut mixer = MicrophoneMix::new(48_000, 48_000, Arc::clone(&settings));
        for _ in 0..201 {
            mixer.push(&[0.05; 480]);
            mixer.mix(&mut [0.0; 480]);
        }
        let noisy_floor = mixer.current_gate();
        settings.request_calibration();
        for _ in 0..201 {
            mixer.push(&[0.001; 480]);
            mixer.mix(&mut [0.0; 480]);
        }
        assert!(mixer.current_gate() < noisy_floor);
    }
}

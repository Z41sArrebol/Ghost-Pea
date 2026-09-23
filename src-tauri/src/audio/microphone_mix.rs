use std::collections::VecDeque;

const MAX_BUFFER_MILLIS: usize = 250;
const TARGET_BUFFER_MILLIS: usize = 20;
const MIC_GAIN: f32 = 1.0;
const NOISE_GATE_RATIO: f32 = 2.5;
const MIN_NOISE_GATE: f32 = 0.008;
const MIN_MIC_GAIN: f32 = 0.15;

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
}

impl MicrophoneMix {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
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

    pub fn mix(&mut self, output: &mut [f32]) {
        let target_len = self.input_rate as usize * TARGET_BUFFER_MILLIS / 1_000;
        let adjustment = if self.samples.len() > target_len * 2 {
            1.002
        } else {
            1.0
        };
        let step = self.input_rate as f64 / self.output_rate as f64 * adjustment;
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
            if self.calibration_samples < self.output_rate as usize * 2 {
                self.calibration_sum += (microphone * microphone) as f64;
                self.calibration_samples += 1;
                *sample = (*sample + microphone * MIN_MIC_GAIN * MIC_GAIN).clamp(-1.0, 1.0);
                if self.calibration_samples == self.output_rate as usize * 2 {
                    self.noise_floor = ((self.calibration_sum / self.calibration_samples as f64)
                        .sqrt() as f32
                        * NOISE_GATE_RATIO)
                        .clamp(MIN_NOISE_GATE, 0.2);
                }
            } else {
                let target =
                    ((self.envelope / self.noise_floor - 0.4) / 0.8).clamp(MIN_MIC_GAIN, 1.0);
                self.gain += (target - self.gain) * if target > self.gain { 0.002 } else { 0.0002 };
                *sample = (*sample + microphone * self.gain * MIC_GAIN).clamp(-1.0, 1.0);
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

    #[test]
    fn missing_microphone_does_not_block_system_audio() {
        let mut mixer = MicrophoneMix::new(44_100, 48_000);
        let mut output = [0.25; 480];
        mixer.mix(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.25));
    }

    #[test]
    fn calibrated_voice_contributes_at_different_sample_rates() {
        let mut mixer = MicrophoneMix::new(44_100, 48_000);
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
        let mut mixer = MicrophoneMix::new(48_000, 48_000);
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
}

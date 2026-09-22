use std::{
    sync::atomic::{AtomicU32, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use serde::Serialize;

const METRIC_WINDOW_CAPACITY: usize = 512;
const REPORT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DspPerformance {
    pub sample_count: u64,
    pub window_ms: u32,
    pub last_us: u32,
    pub p50_us: u32,
    pub p95_us: u32,
    pub p99_us: u32,
    pub max_us: u32,
    pub pipeline_lag_us: u32,
    pub deadline_misses: u64,
}

#[derive(Default)]
pub struct SharedDspPerformance {
    sample_count: AtomicU64,
    window_ms: AtomicU32,
    last_us: AtomicU32,
    p50_us: AtomicU32,
    p95_us: AtomicU32,
    p99_us: AtomicU32,
    max_us: AtomicU32,
    pipeline_lag_us: AtomicU32,
    deadline_misses: AtomicU64,
}

impl SharedDspPerformance {
    pub fn publish(&self, performance: DspPerformance) {
        self.window_ms
            .store(performance.window_ms, Ordering::Relaxed);
        self.last_us.store(performance.last_us, Ordering::Relaxed);
        self.p50_us.store(performance.p50_us, Ordering::Relaxed);
        self.p95_us.store(performance.p95_us, Ordering::Relaxed);
        self.p99_us.store(performance.p99_us, Ordering::Relaxed);
        self.max_us.store(performance.max_us, Ordering::Relaxed);
        self.pipeline_lag_us
            .store(performance.pipeline_lag_us, Ordering::Relaxed);
        self.deadline_misses
            .store(performance.deadline_misses, Ordering::Relaxed);
        self.sample_count
            .store(performance.sample_count, Ordering::Release);
    }

    pub fn snapshot(&self) -> DspPerformance {
        let sample_count = self.sample_count.load(Ordering::Acquire);
        DspPerformance {
            sample_count,
            window_ms: self.window_ms.load(Ordering::Relaxed),
            last_us: self.last_us.load(Ordering::Relaxed),
            p50_us: self.p50_us.load(Ordering::Relaxed),
            p95_us: self.p95_us.load(Ordering::Relaxed),
            p99_us: self.p99_us.load(Ordering::Relaxed),
            max_us: self.max_us.load(Ordering::Relaxed),
            pipeline_lag_us: self.pipeline_lag_us.load(Ordering::Relaxed),
            deadline_misses: self.deadline_misses.load(Ordering::Relaxed),
        }
    }
}

pub struct DspMetrics {
    durations_us: [u32; METRIC_WINDOW_CAPACITY],
    write_index: usize,
    valid_count: usize,
    sample_count: u64,
    deadline_us: u32,
    sample_interval_us: u32,
    deadline_misses: u64,
    last_report: Instant,
}

impl DspMetrics {
    pub fn new(sample_rate_hz: u32, hop_size: usize) -> Self {
        let sample_interval_us = ((hop_size as u64 * 1_000_000) / u64::from(sample_rate_hz)) as u32;
        Self {
            durations_us: [0; METRIC_WINDOW_CAPACITY],
            write_index: 0,
            valid_count: 0,
            sample_count: 0,
            deadline_us: sample_interval_us,
            sample_interval_us,
            deadline_misses: 0,
            last_report: Instant::now(),
        }
    }

    pub fn record(&mut self, elapsed: Duration, pipeline_lag_us: u32) -> Option<DspPerformance> {
        let elapsed_us = elapsed.as_micros().min(u128::from(u32::MAX)) as u32;
        self.durations_us[self.write_index] = elapsed_us;
        self.write_index = (self.write_index + 1) % METRIC_WINDOW_CAPACITY;
        self.valid_count = (self.valid_count + 1).min(METRIC_WINDOW_CAPACITY);
        self.sample_count += 1;
        if elapsed_us > self.deadline_us {
            self.deadline_misses += 1;
        }

        if self.last_report.elapsed() < REPORT_INTERVAL {
            return None;
        }
        self.last_report = Instant::now();

        let mut sorted = [0_u32; METRIC_WINDOW_CAPACITY];
        sorted[..self.valid_count].copy_from_slice(&self.durations_us[..self.valid_count]);
        let values = &mut sorted[..self.valid_count];
        values.sort_unstable();

        Some(DspPerformance {
            sample_count: self.sample_count,
            window_ms: self
                .sample_interval_us
                .saturating_mul(self.valid_count as u32)
                / 1_000,
            last_us: elapsed_us,
            p50_us: percentile(values, 50),
            p95_us: percentile(values, 95),
            p99_us: percentile(values, 99),
            max_us: values.last().copied().unwrap_or_default(),
            pipeline_lag_us,
            deadline_misses: self.deadline_misses,
        })
    }
}

fn percentile(sorted: &[u32], percentile: usize) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let index = (sorted.len() * percentile).div_ceil(100) - 1;
    sorted[index]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_percentiles_without_heap_growth() {
        let mut metrics = DspMetrics::new(48_000, 512);
        metrics.last_report -= REPORT_INTERVAL;

        for micros in 1..100 {
            let report = metrics.record(Duration::from_micros(micros), 2_000);
            if micros == 1 {
                let report = report.expect("first forced report");
                assert_eq!(report.sample_count, 1);
            }
        }

        metrics.last_report -= REPORT_INTERVAL;
        let report = metrics
            .record(Duration::from_micros(100), 3_000)
            .expect("second forced report");

        assert_eq!(report.sample_count, 100);
        assert_eq!(report.p50_us, 50);
        assert_eq!(report.p95_us, 95);
        assert_eq!(report.p99_us, 99);
        assert_eq!(report.max_us, 100);
        assert_eq!(report.pipeline_lag_us, 3_000);
        assert_eq!(report.deadline_misses, 0);
    }

    #[test]
    fn counts_deadline_misses() {
        let mut metrics = DspMetrics::new(48_000, 512);
        metrics.last_report -= REPORT_INTERVAL;
        let report = metrics
            .record(Duration::from_millis(11), 0)
            .expect("forced report");

        assert_eq!(report.deadline_misses, 1);
    }
}

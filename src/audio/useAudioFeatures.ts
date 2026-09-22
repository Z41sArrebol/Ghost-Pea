import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

// 与 docs/audio-monitor-api.md 对齐
export interface AudioStatus {
  running: boolean;
  sampleRateHz: number;
  channels: number;
  capturedFrames: number;
  droppedSamples: number;
  sequence: number;
  capturedAtUs: number;
  rms: number;
  bass: number;
  mid: number;
  treble: number;
  onset: number;
  centroid: number;
  energyTrend: number;
  silence: boolean;
}

export interface AudioFeatures {
  sequence: number;
  capturedAtUs: number;
  rms: number;
  bass: number;
  mid: number;
  treble: number;
  onset: number;
  centroid: number;
  energyTrend: number;
  silence: boolean;
}

const ZERO_FEATURES: AudioFeatures = {
  sequence: 0,
  capturedAtUs: 0,
  rms: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  onset: 0,
  centroid: 0,
  energyTrend: 0,
  silence: true,
};

export type AudioSource = "tauri" | "simulation" | "off";

const STATUS_POLL_MS = 1000;
const SIM_INTERVAL_MS = 33;

export interface AudioFeaturesHandle {
  featuresRef: React.MutableRefObject<AudioFeatures>;
  running: boolean;
  source: AudioSource;
  status: AudioStatus | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function useAudioFeatures(): AudioFeaturesHandle {
  const featuresRef = useRef<AudioFeatures>(ZERO_FEATURES);
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState<AudioSource>("off");
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const simTimerRef = useRef<number | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const tauri = isTauri();

  const teardown = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (simTimerRef.current !== null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    if (statusTimerRef.current !== null) {
      window.clearInterval(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    featuresRef.current = ZERO_FEATURES;
  }, []);

  const start = useCallback(async () => {
    if (unlistenRef.current !== null || simTimerRef.current !== null) return;

    if (tauri) {
      await invoke("start_audio_monitor");
      setSource("tauri");
      let lastSequence = 0;
      unlistenRef.current = await listen<AudioFeatures>("audio-features", ({ payload }) => {
        // 契约：序号允许跳号不允许倒退
        if (payload.sequence <= lastSequence) return;
        lastSequence = payload.sequence;
        featuresRef.current = payload;
      });
      statusTimerRef.current = window.setInterval(async () => {
        try {
          setStatus(await invoke<AudioStatus>("audio_monitor_status"));
        } catch {
          // 状态面板轮询失败可忽略
        }
      }, STATUS_POLL_MS);
    } else {
      // 浏览器里模拟全字段特征，方便调滤镜手感
      setSource("simulation");
      const t0 = performance.now();
      let sequence = 0;
      let prevRms = 0;
      simTimerRef.current = window.setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        const swell = Math.max(0, Math.sin(t * 1.3)) * 0.35;
        const beatPhase = Math.pow(Math.max(0, Math.sin(t * 4.6)), 12);
        const rms = Math.min(1, swell + beatPhase * 0.55 + Math.random() * 0.04);
        const bassWeight = 0.4 + 0.25 * Math.sin(t * 0.7);
        const trebleWeight = 0.25 + 0.15 * Math.sin(t * 0.9 + 2);
        const midWeight = Math.max(0.05, 1 - bassWeight - trebleWeight);
        const weightSum = bassWeight + midWeight + trebleWeight;
        featuresRef.current = {
          sequence: ++sequence,
          capturedAtUs: Math.round(t * 1_000_000),
          rms,
          bass: bassWeight / weightSum,
          mid: midWeight / weightSum,
          treble: trebleWeight / weightSum,
          onset: Math.min(1, beatPhase * 1.2),
          centroid: 0.5 + 0.3 * Math.sin(t * 0.5),
          energyTrend: Math.max(-1, Math.min(1, (rms - prevRms) * 20)),
          silence: rms < 0.001,
        };
        prevRms = rms;
      }, SIM_INTERVAL_MS);
    }
    setRunning(true);
  }, [tauri]);

  const stop = useCallback(async () => {
    teardown();
    if (tauri) {
      try {
        await invoke("stop_audio_monitor");
      } catch {
        // 后端可能已经停了
      }
    }
    setStatus(null);
    setRunning(false);
    setSource("off");
  }, [tauri, teardown]);

  useEffect(() => teardown, [teardown]);

  return { featuresRef, running, source, status, start, stop };
}

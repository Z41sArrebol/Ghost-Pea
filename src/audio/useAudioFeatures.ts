import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

// 与 docs/audio-monitor-api.md 对齐
export type AudioRuntimeState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface AudioStatus {
  running: boolean;
  state: AudioRuntimeState;
  lastError: string | null;
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
  sequence: 0, capturedAtUs: 0, rms: 0, bass: 0, mid: 0, treble: 0,
  onset: 0, centroid: 0.5, energyTrend: 0, silence: true,
};

export type AudioSource = "tauri" | "simulation" | "off";
export const AUDIO_STALE_MS = 1000;
const STATUS_POLL_MS = 1000;
const SIM_INTERVAL_MS = 33;

export interface AudioFeaturesHandle {
  featuresRef: MutableRefObject<AudioFeatures>;
  lastReceivedAtRef: MutableRefObject<number | null>;
  running: boolean;
  source: AudioSource;
  status: AudioStatus | null;
  busy: boolean;
  error: string | null;
  stale: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

type Session = {
  active: boolean;
  unlisten: (() => void) | null;
  timers: number[];
  lastSequence: number;
};

// 后端为单例，跨挂载串行化，旧会话只能停止自己持有的后端。
let lifecycle = Promise.resolve();
let backendOwner: Session | null = null;
let statusPolling = false;
function serialize(operation: () => Promise<void>): Promise<void> {
  const result = lifecycle.then(operation);
  lifecycle = result.catch(() => {});
  return result;
}

function dispose(session: Session) {
  session.active = false;
  session.timers.forEach(window.clearInterval);
  session.timers = [];
  const unlisten = session.unlisten;
  session.unlisten = null;
  unlisten?.();
}

function terminal(status: AudioStatus) {
  return status.state === "failed" || status.state === "stopped";
}

async function releaseBackend(session: Session): Promise<AudioStatus | null> {
  if (backendOwner !== session) return null;
  const status = await invoke<AudioStatus>("stop_audio_monitor");
  if (status.running || !terminal(status)) {
    throw new Error(status.lastError || "音频后端尚未确认停止，请重试停止");
  }
  backendOwner = null;
  return status;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: unknown, fallback = 0, min = 0, max = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value)) : fallback;
}

function normalize(payload: unknown, lastSequence: number): AudioFeatures | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<AudioFeatures>;
  const sequence = p.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= lastSequence) return null;
  const bass = bounded(p.bass);
  const mid = bounded(p.mid);
  const treble = bounded(p.treble);
  const sum = bass + mid + treble;
  return {
    sequence,
    capturedAtUs: bounded(p.capturedAtUs, 0, 0, Number.MAX_SAFE_INTEGER),
    rms: bounded(p.rms),
    bass: sum ? bass / sum : 0,
    mid: sum ? mid / sum : 0,
    treble: sum ? treble / sum : 0,
    onset: bounded(p.onset),
    centroid: bounded(p.centroid, 0.5),
    energyTrend: bounded(p.energyTrend, 0, -1, 1),
    silence: typeof p.silence === "boolean" ? p.silence : true,
  };
}

export function useAudioFeatures(): AudioFeaturesHandle {
  const featuresRef = useRef<AudioFeatures>({ ...ZERO_FEATURES });
  const lastReceivedAtRef = useRef<number | null>(null);
  const mounted = useRef(false);
  const current = useRef<Session | null>(null);
  const request = useRef(0);
  const pendingStop = useRef<Promise<void> | null>(null);
  const [view, setView] = useState({
    running: false, source: "off" as AudioSource, status: null as AudioStatus | null,
    busy: false, error: null as string | null, stale: false,
  });
  const tauri = isTauri();

  const neutralize = useCallback(() => {
    featuresRef.current = { ...ZERO_FEATURES };
    lastReceivedAtRef.current = null;
  }, []);

  const isCurrent = useCallback((session: Session) => (
    mounted.current && current.current === session && session.active
  ), []);

  const accept = useCallback((session: Session, payload: unknown) => {
    if (!isCurrent(session)) return;
    const features = normalize(payload, session.lastSequence);
    if (!features) return;
    session.lastSequence = features.sequence;
    featuresRef.current = features;
    lastReceivedAtRef.current = performance.now();
    setView(previous => previous.stale ? { ...previous, stale: false } : previous);
  }, [isCurrent]);

  const applyStatus = useCallback((session: Session, status: AudioStatus) => {
    if (!isCurrent(session)) return;
    if (terminal(status)) {
      dispose(session);
      if (backendOwner === session) backendOwner = null;
      current.current = null;
      neutralize();
      setView({
        running: false, source: "off", status, busy: false, stale: false,
        error: status.lastError || (status.state === "failed" ? "音频后端运行失败，请重新启动" : null),
      });
    } else {
      setView(previous => ({ ...previous, status, running: status.running, error: status.lastError }));
    }
  }, [isCurrent, neutralize]);

  const start = useCallback((): Promise<void> => {
    if (!mounted.current || current.current?.active) return Promise.resolve();
    const session: Session = { active: true, unlisten: null, timers: [], lastSequence: 0 };
    current.current = session;
    pendingStop.current = null;
    const id = ++request.current;
    neutralize();
    setView(previous => ({ ...previous, busy: true, error: null, stale: false, status: null }));

    return serialize(async () => {
      if (!isCurrent(session)) return;
      // 上次停止失败时，必须先释放旧会话，再启动新会话。
      if (tauri && backendOwner && !backendOwner.active) await releaseBackend(backendOwner);
      if (!isCurrent(session)) return;
      if (tauri) {
        const unlisten = await listen<unknown>("audio-features", ({ payload }) => accept(session, payload));
        if (!isCurrent(session)) { unlisten(); return; }
        session.unlisten = unlisten;
        const status = await invoke<AudioStatus>("start_audio_monitor");
        if (!terminal(status)) backendOwner = session;
        if (!isCurrent(session)) {
          await releaseBackend(session);
          return;
        }
        setView(previous => ({ ...previous, source: "tauri", busy: false }));
        applyStatus(session, status);
        if (!isCurrent(session)) return;
        session.timers.push(window.setInterval(async () => {
          if (!isCurrent(session) || statusPolling) return;
          statusPolling = true;
          try {
            applyStatus(session, await invoke<AudioStatus>("audio_monitor_status"));
          } catch (error) {
            // A failed query is not confirmation that the backend has stopped.
            if (isCurrent(session)) setView(previous => ({ ...previous, error: errorMessage(error) }));
          } finally {
            statusPolling = false;
          }
        }, STATUS_POLL_MS));
      } else {
        setView({ running: true, source: "simulation", status: null, busy: false, error: null, stale: false });
        const t0 = performance.now();
        let sequence = 0;
        let prevRms = 0;
        session.timers.push(window.setInterval(() => {
          const t = (performance.now() - t0) / 1000;
          const swell = Math.max(0, Math.sin(t * 1.3)) * 0.35;
          const beatPhase = Math.pow(Math.max(0, Math.sin(t * 4.6)), 12);
          const rms = Math.min(1, swell + beatPhase * 0.55 + Math.random() * 0.04);
          const bass = 0.4 + 0.25 * Math.sin(t * 0.7);
          const treble = 0.25 + 0.15 * Math.sin(t * 0.9 + 2);
          accept(session, {
            sequence: ++sequence, capturedAtUs: Math.round(t * 1_000_000), rms,
            bass, mid: Math.max(0.05, 1 - bass - treble), treble,
            onset: Math.min(1, beatPhase * 1.2), centroid: 0.5 + 0.3 * Math.sin(t * 0.5),
            energyTrend: (rms - prevRms) * 20, silence: rms < 0.001,
          });
          prevRms = rms;
        }, SIM_INTERVAL_MS));
      }
      const startedAt = performance.now();
      session.timers.push(window.setInterval(() => {
        if (!isCurrent(session)) return;
        const stale = performance.now() - (lastReceivedAtRef.current ?? startedAt) >= AUDIO_STALE_MS;
        if (stale) featuresRef.current = { ...ZERO_FEATURES };
        setView(previous => previous.stale === stale ? previous : { ...previous, stale });
      }, 100));
    }).catch(error => {
      dispose(session);
      if (!mounted.current || request.current !== id) return;
      const owned = backendOwner;
      current.current = owned;
      neutralize();
      setView({
        running: !!owned, source: owned ? "tauri" : "off", status: null,
        busy: false, stale: !!owned, error: errorMessage(error),
      });
    });
  }, [accept, applyStatus, isCurrent, neutralize, tauri]);

  const stop = useCallback((): Promise<void> => {
    if (pendingStop.current) return pendingStop.current;
    const session = current.current;
    const id = ++request.current;
    if (session) dispose(session);
    current.current = null;
    neutralize();
    if (mounted.current) setView(previous => ({ ...previous, busy: true, stale: false }));
    const result = serialize(async () => {
      const status = session ? await releaseBackend(session) : null;
      if (!mounted.current || request.current !== id) return;
      setView({ running: false, source: "off", status, busy: false, error: status?.lastError ?? null, stale: false });
    }).catch(error => {
      if (!mounted.current || request.current !== id) return;
      current.current = session; // Inactive, but still owned: stop/start can retry.
      setView(previous => ({
        ...previous, running: true, source: "tauri", busy: false, stale: true, error: errorMessage(error),
      }));
    }).finally(() => {
      if (pendingStop.current === result) pendingStop.current = null;
    });
    pendingStop.current = result;
    return result;
  }, [neutralize]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void stop(); // Serialized compensation also covers a start that resolves after cleanup.
    };
  }, [stop]);

  return { featuresRef, lastReceivedAtRef, ...view, start, stop };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTauriAudioMoodService,
  type AudioMoodService,
  type AudioMoodStatus,
  type MoodResult,
} from "../../packages/audio-ai/src";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { calibrateHappySad, calibrateRelaxedAggressive, DEFAULT_VALENCE_SENSITIVITY } from "./moodCalibration";

export type MoodState = "calm" | "bright" | "intense" | "dark" | "neutral";
export type DominantMood = "happy" | "sad" | "relaxed" | "aggressive";
export type MoodLabel = DominantMood | "neutral";
export type AiMood = MoodResult["scores"] &
  Pick<MoodResult, "streamEpoch" | "sequence" | "confidence" | "inferenceMs" | "modelReady"> & {
    rawHappy: number;
    rawSad: number;
    rawRelaxed: number;
    rawAggressive: number;
    valence: number;
    silent: boolean;
    receivedAt: number;
  };
type RawAiMood = MoodResult["scores"] &
  Pick<MoodResult, "streamEpoch" | "sequence" | "inferenceMs" | "modelReady"> & { receivedAt: number };

const HAPPY_VALENCE_THRESHOLD = 0.65;
const SAD_VALENCE_THRESHOLD = 0.35;
const AGGRESSIVE_THRESHOLD = 0.55;
const RELAXED_THRESHOLD = 0.6;
const AI_STALE_MS = 2500;
const STALE_CHECK_MS = 1000;
const BACKEND_CHECK_MS = 1000;
const MODEL_BASE_URL = "/models/audio-ai";

interface AudioMonitorStatus {
  running: boolean;
}

function getDominanceConfidence(mood: MoodResult["scores"]): number {
  const [highest = 0, secondHighest = 0] = Object.values(mood).sort((left, right) => right - left);
  return highest > 0 ? (highest - secondHighest) / highest : 0;
}

export function getActiveAiMood(mood: AiMood | null, status: AudioMoodStatus, now: number): AiMood | null {
  if (!mood || !mood.modelReady || mood.silent || !status.modelReady || !status.backendConnected) return null;
  if (status.phase !== "running" && status.phase !== "degraded") return null;
  const age = now - mood.receivedAt;
  return age >= 0 && age <= AI_STALE_MS ? mood : null;
}

export function resolveDominantMood(mood: AiMood | null): DominantMood | null {
  if (!mood || !mood.modelReady || mood.silent) return null;
  const candidates = [
    ["happy", mood.happy],
    ["sad", mood.sad],
    ["relaxed", mood.relaxed],
    ["aggressive", mood.aggressive],
  ] as const;
  return candidates.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

export function resolveMoodLabel(mood: AiMood | null): MoodLabel {
  if (!mood || !mood.modelReady || mood.silent) return "neutral";
  if (mood.aggressive >= AGGRESSIVE_THRESHOLD) return "aggressive";
  if (mood.valence >= HAPPY_VALENCE_THRESHOLD) return "happy";
  if (mood.valence <= SAD_VALENCE_THRESHOLD) return "sad";
  if (mood.relaxed >= RELAXED_THRESHOLD) return "relaxed";
  return "neutral";
}

export function resolveMoodState(mood: AiMood | null): MoodState {
  const moodLabel = resolveMoodLabel(mood);
  if (moodLabel === "neutral") return "neutral";
  return {
    happy: "bright",
    sad: "dark",
    relaxed: "calm",
    aggressive: "intense",
  }[moodLabel] as MoodState;
}

export interface AiMoodHandle {
  mood: AiMood | null;
  moodLabel: MoodLabel;
  moodState: MoodState;
  dominantMood: DominantMood | null;
  workerReady: boolean;
  stale: boolean;
  status: AudioMoodStatus;
  error: string | null;
  selfTest: () => void;
}

export function useAiMood(valenceSensitivity = DEFAULT_VALENCE_SENSITIVITY): AiMoodHandle {
  const serviceRef = useRef<AudioMoodService | null>(null);
  const lastMoodAtRef = useRef(0);
  const [rawMood, setRawMood] = useState<RawAiMood | null>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState<AudioMoodStatus>({
    phase: "idle",
    modelReady: false,
    backendConnected: false,
    lastError: null,
  });

  useEffect(() => {
    const service = createTauriAudioMoodService({ modelBaseUrl: MODEL_BASE_URL });
    serviceRef.current = service;

    const unsubscribeResult = service.subscribe((result) => {
      const { happy, sad, relaxed, aggressive } = result.scores;
      if (![happy, sad, relaxed, aggressive].every((score) => Number.isFinite(score) && score >= 0 && score <= 1)) {
        setRawMood(null);
        return;
      }
      lastMoodAtRef.current = performance.now();
      setStale(false);
      setRawMood({
        ...result.scores,
        streamEpoch: result.streamEpoch,
        sequence: result.sequence,
        inferenceMs: result.inferenceMs,
        modelReady: result.modelReady,
        receivedAt: lastMoodAtRef.current,
      });
    });
    const unsubscribeStatus = service.subscribeStatus((next) => {
      setStatus(next);
      if (!next.modelReady || !next.backendConnected || (next.phase !== "running" && next.phase !== "degraded")) {
        setRawMood(null);
        lastMoodAtRef.current = 0;
        setStale(false);
      }
    });
    let syncing = false;
    const syncWithAudioMonitor = async () => {
      if (syncing || !isTauri()) return;
      syncing = true;
      try {
        const audioStatus = await invoke<AudioMonitorStatus>("audio_monitor_status");
        const phase = service.getStatus().phase;
        if (audioStatus.running && (phase === "idle" || phase === "failed")) {
          await service.start();
        } else if (!audioStatus.running && phase !== "idle") {
          await service.stop();
        }
      } catch {
        // Service status reports connection failures; polling retries when audio becomes available.
      } finally {
        syncing = false;
      }
    };
    void syncWithAudioMonitor();
    const backendTimer = window.setInterval(() => void syncWithAudioMonitor(), BACKEND_CHECK_MS);

    return () => {
      window.clearInterval(backendTimer);
      unsubscribeResult();
      unsubscribeStatus();
      serviceRef.current = null;
      void service.dispose();
    };
  }, []);

  const mood: AiMood | null = rawMood
    ? (() => {
        const silent = [rawMood.happy, rawMood.sad, rawMood.relaxed, rawMood.aggressive].every((score) => score === 0);
        const calibrated = silent
          ? { happy: 0, sad: 0, valence: 0.5 }
          : calibrateHappySad(rawMood.happy, rawMood.sad, valenceSensitivity);
        const arousal = calibrateRelaxedAggressive(rawMood.relaxed, rawMood.aggressive);
        const scores = {
          happy: calibrated.happy,
          sad: calibrated.sad,
          relaxed: arousal.relaxed,
          aggressive: arousal.aggressive,
        };
        return {
          ...rawMood,
          ...scores,
          rawHappy: rawMood.happy,
          rawSad: rawMood.sad,
          rawRelaxed: rawMood.relaxed,
          rawAggressive: rawMood.aggressive,
          valence: calibrated.valence,
          silent,
          confidence: getDominanceConfidence(scores),
        };
      })()
    : null;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const hasMood = lastMoodAtRef.current > 0;
      setStale(hasMood && performance.now() - lastMoodAtRef.current > AI_STALE_MS);
    }, STALE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const selfTest = useCallback(() => {
    const service = serviceRef.current;
    if (!service) return;
    setRawMood(null);
    lastMoodAtRef.current = 0;
    setStale(false);
    void service.stop().then(() => service.start()).catch(() => undefined);
  }, []);

  const workerReady = status.phase === "running" || status.phase === "degraded";
  const activeMood = getActiveAiMood(mood, status, performance.now());
  return {
    mood,
    moodLabel: resolveMoodLabel(activeMood),
    moodState: resolveMoodState(activeMood),
    dominantMood: resolveDominantMood(activeMood),
    workerReady,
    stale,
    status,
    error: status.lastError,
    selfTest,
  };
}

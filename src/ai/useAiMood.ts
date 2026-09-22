import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTauriAudioMoodService,
  type AudioMoodService,
  type AudioMoodStatus,
  type MoodResult,
} from "../../packages/audio-ai/src";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type MoodState = "calm" | "bright" | "intense" | "dark" | "neutral";
export type AiMood = MoodResult["scores"] &
  Pick<MoodResult, "streamEpoch" | "sequence" | "confidence" | "inferenceMs" | "modelReady">;

const CONFIDENCE_THRESHOLD = 0.5;
const AI_STALE_MS = 2500;
const STALE_CHECK_MS = 1000;
const BACKEND_CHECK_MS = 1000;
const MODEL_BASE_URL = "/models/audio-ai";

interface AudioMonitorStatus {
  running: boolean;
}

export function resolveMoodState(mood: AiMood | null): MoodState {
  if (!mood || !mood.modelReady || mood.confidence < CONFIDENCE_THRESHOLD) return "neutral";
  const candidates = [
    ["bright", mood.happy],
    ["dark", mood.sad],
    ["calm", mood.relaxed],
    ["intense", mood.aggressive],
  ] as const;
  return candidates.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

export interface AiMoodHandle {
  mood: AiMood | null;
  moodState: MoodState;
  workerReady: boolean;
  stale: boolean;
  status: AudioMoodStatus;
  error: string | null;
  selfTest: () => void;
}

export function useAiMood(): AiMoodHandle {
  const serviceRef = useRef<AudioMoodService | null>(null);
  const lastMoodAtRef = useRef(0);
  const [mood, setMood] = useState<AiMood | null>(null);
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
      lastMoodAtRef.current = performance.now();
      setStale(false);
      setMood({
        ...result.scores,
        streamEpoch: result.streamEpoch,
        sequence: result.sequence,
        confidence: result.confidence,
        inferenceMs: result.inferenceMs,
        modelReady: result.modelReady,
      });
    });
    const unsubscribeStatus = service.subscribeStatus(setStatus);
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
    void service.stop().then(() => service.start()).catch(() => undefined);
  }, []);

  const workerReady = status.phase === "running" || status.phase === "degraded";
  return {
    mood,
    moodState: resolveMoodState(mood),
    workerReady,
    stale,
    status,
    error: status.lastError,
    selfTest,
  };
}

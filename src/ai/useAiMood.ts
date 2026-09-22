import { useCallback, useEffect, useRef, useState } from "react";
import type { AiMood, MainToWorker, WorkerToMain } from "./messages";

// 契约 5.3 映射到产品氛围状态（架构 §4.5 慢速状态表）
export type MoodState = "calm" | "bright" | "intense" | "dark" | "neutral";

const CONFIDENCE_THRESHOLD = 0.5;
const AI_STALE_MS = 2500;
const STALE_CHECK_MS = 1000;

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
  // true = 超过 AI_STALE_MS 没收到输出。按契约此时保持当前状态，不回落
  stale: boolean;
  sendPcm: (buffer: ArrayBuffer, capturedAtUs: number) => void;
  selfTest: () => void;
}

export function useAiMood(): AiMoodHandle {
  const workerRef = useRef<Worker | null>(null);
  const lastMoodAtRef = useRef(0);
  const [mood, setMood] = useState<AiMood | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL("./mood.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          setWorkerReady(true);
          break;
        case "mood":
          lastMoodAtRef.current = performance.now();
          setStale(false);
          setMood(message.mood);
          break;
        case "error":
          console.error("[ai] worker error:", message.message);
          break;
      }
    };
    worker.postMessage({ type: "ping" } satisfies MainToWorker);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const hasMood = lastMoodAtRef.current > 0;
      setStale(hasMood && performance.now() - lastMoodAtRef.current > AI_STALE_MS);
    }, STALE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const sendPcm = useCallback((buffer: ArrayBuffer, capturedAtUs: number) => {
    // buffer 所有权转移给 Worker，调用方之后不得再读写
    workerRef.current?.postMessage(
      { type: "pcm", buffer, sampleRate: 16000, capturedAtUs } satisfies MainToWorker,
      [buffer],
    );
  }, []);

  const selfTest = useCallback(() => {
    workerRef.current?.postMessage({ type: "self-test" } satisfies MainToWorker);
  }, []);

  return { mood, moodState: resolveMoodState(mood), workerReady, stale, sendPcm, selfTest };
}

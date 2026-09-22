// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioMoodService, AudioMoodStatus, MoodResult } from "../../packages/audio-ai/src";
import { calibrateHappySad } from "./moodCalibration";
import { getActiveAiMood, resolveDominantMood, resolveMoodLabel, useAiMood } from "./useAiMood";

const api = vi.hoisted(() => ({ createService: vi.fn(), invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("../../packages/audio-ai/src", () => ({ createTauriAudioMoodService: api.createService }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke, isTauri: api.isTauri }));

const rawScores = { happy: 0.23, sad: 0.6, relaxed: 0.3, aggressive: 0.1 };
const silence = { happy: 0, sad: 0, relaxed: 0, aggressive: 0 };
const ready = (overrides: Partial<AudioMoodStatus> = {}): AudioMoodStatus => ({
  phase: "running", modelReady: true, backendConnected: true, lastError: null, ...overrides,
});
const moodResult = (overrides: Partial<MoodResult> = {}): MoodResult => ({
  scores: { ...rawScores }, streamEpoch: 7n, sequence: 1n,
  confidence: 0.99, inferenceMs: 12, modelReady: true, ...overrides,
});
const unavailableStatuses: Array<[string, Partial<AudioMoodStatus>]> = [
  ["idle", { phase: "idle" }],
  ["loading", { phase: "loading" }],
  ["failed", { phase: "failed", lastError: "inference failed" }],
  ["disposed", { phase: "disposed" }],
  ["disconnected", { backendConnected: false }],
  ["model not ready", { modelReady: false }],
  ["degraded placeholder", { phase: "degraded", modelReady: false }],
  ["degraded disconnected", { phase: "degraded", backendConnected: false }],
];
const neutral = { moodLabel: "neutral", moodState: "neutral", dominantMood: null };

let onResult: (result: MoodResult) => void;
let onStatus: (status: AudioMoodStatus) => void;
let serviceStatus: AudioMoodStatus;
const unsubscribeResult = vi.fn();
const unsubscribeStatus = vi.fn();
const service = {
  start: vi.fn<AudioMoodService["start"]>(),
  stop: vi.fn<AudioMoodService["stop"]>(),
  dispose: vi.fn<AudioMoodService["dispose"]>(),
  subscribe: vi.fn<AudioMoodService["subscribe"]>(),
  subscribeStatus: vi.fn<AudioMoodService["subscribeStatus"]>(),
  getStatus: vi.fn<AudioMoodService["getStatus"]>(),
} satisfies AudioMoodService;

function emit(result = moodResult()) {
  act(() => onResult(result));
}
function emitStatus(overrides: Partial<AudioMoodStatus> = {}) {
  act(() => {
    serviceStatus = ready(overrides);
    onStatus(serviceStatus);
  });
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
  vi.resetAllMocks();
  serviceStatus = ready();
  service.start.mockResolvedValue(undefined);
  service.stop.mockResolvedValue(undefined);
  service.dispose.mockResolvedValue(undefined);
  service.getStatus.mockImplementation(() => serviceStatus);
  service.subscribe.mockImplementation(listener => {
    onResult = listener;
    return unsubscribeResult;
  });
  service.subscribeStatus.mockImplementation(listener => {
    onStatus = listener;
    listener(serviceStatus);
    return unsubscribeStatus;
  });
  api.createService.mockReturnValue(service);
  api.isTauri.mockReturnValue(true);
  api.invoke.mockResolvedValue({ running: true });
});
afterEach(async () => {
  cleanup();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("AI mood calibration", () => {
  it.each([undefined, 4, 40])("bypasses calibration for silence at sensitivity %s", sensitivity => {
    const { result } = renderHook(() => useAiMood(sensitivity));
    emit(moodResult({ scores: silence }));
    expect(result.current.mood).toMatchObject({
      ...silence, rawHappy: 0, rawSad: 0, valence: 0.5, confidence: 0, silent: true,
    });
    expect(result.current).toMatchObject(neutral);
    expect(resolveMoodLabel(result.current.mood)).toBe("neutral");
    expect(resolveDominantMood(result.current.mood)).toBeNull();
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBeNull();
  });

  it.each([
    ["happy", 0.23, 0.6],
    ["sad", 0.15, 0.8],
  ] as const)("recalibrates %s evidence without refreshing reception time", async (_name, happy, sad) => {
    const { result, rerender } = renderHook(
      ({ sensitivity }: { sensitivity: number | undefined }) => useAiMood(sensitivity),
      { initialProps: { sensitivity: undefined as number | undefined } },
    );
    await advance(100);
    emit(moodResult({ scores: { ...rawScores, happy, sad } }));
    const receivedAt = performance.now();
    let previousHappy: number | undefined;
    for (const sensitivity of [undefined, 4, 40]) {
      await advance(100);
      rerender({ sensitivity });
      const calibrated = calibrateHappySad(happy, sad, sensitivity ?? 24);
      expect(result.current.mood).toMatchObject({
        ...calibrated, relaxed: rawScores.relaxed, aggressive: rawScores.aggressive,
        rawHappy: happy, rawSad: sad, silent: false, receivedAt,
        streamEpoch: 7n, sequence: 1n, inferenceMs: 12, modelReady: true,
      });
      const [highest, secondHighest] = [calibrated.happy, calibrated.sad, rawScores.relaxed, rawScores.aggressive]
        .sort((left, right) => right - left);
      expect(result.current.mood?.confidence).toBeCloseTo((highest - secondHighest) / highest);
      expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBe(result.current.mood);
      if (previousHappy !== undefined) expect(result.current.mood?.happy).not.toBe(previousHappy);
      previousHappy = result.current.mood?.happy;
    }
    expect(api.createService).toHaveBeenCalledTimes(1);
    expect(service.subscribe).toHaveBeenCalledTimes(1);
  });

  it.each(["relaxed", "aggressive"] as const)("does not mistake pure %s for silence", dimension => {
    const { result } = renderHook(() => useAiMood());
    emit(moodResult({ scores: { ...silence, [dimension]: 1 } }));
    expect(result.current.mood).toMatchObject({
      ...calibrateHappySad(0, 0, 24), [dimension]: 1, rawHappy: 0, rawSad: 0, silent: false,
    });
    expect(result.current.dominantMood).toBe(dimension);
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBe(result.current.mood);
  });
});

describe("AI mood availability", () => {
  it("requires a result and accepts only reception ages from 0 through 2500 ms", () => {
    const { result } = renderHook(() => useAiMood());
    expect(result.current).toMatchObject({ mood: null, ...neutral });
    expect(getActiveAiMood(null, result.current.status, performance.now())).toBeNull();
    emit();
    const mood = result.current.mood!;
    for (const age of [-1, 0, 1, 2499, 2500, 2501, Infinity, NaN]) {
      expect(getActiveAiMood(mood, result.current.status, mood.receivedAt + age))
        .toBe(age >= 0 && age <= 2500 ? mood : null);
    }
  });

  it("neutralizes expired labels on rerender and on the stale timer, then accepts fresh data", async () => {
    const { result, rerender } = renderHook(() => useAiMood());
    await advance(100);
    emit();
    const receivedAt = performance.now();
    expect(result.current).toMatchObject({ moodLabel: "happy", moodState: "bright", dominantMood: "happy", stale: false });
    vi.setSystemTime(new Date("2040-01-01"));
    await advance(2500);
    rerender();
    expect(result.current.mood?.receivedAt).toBe(receivedAt);
    expect(result.current.moodLabel).toBe("happy");
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBe(result.current.mood);
    await advance(1);
    rerender();
    expect(result.current).toMatchObject(neutral);
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBeNull();
    await advance(1000);
    expect(result.current).toMatchObject({ ...neutral, stale: true });
    expect(result.current.mood?.receivedAt).toBe(receivedAt);
    emit(moodResult({ sequence: 2n }));
    expect(result.current).toMatchObject({ moodLabel: "happy", dominantMood: "happy", stale: false });
    expect(result.current.mood).toMatchObject({ sequence: 2n, receivedAt: performance.now() });
  });

  it.each(unavailableStatuses)("clears old data on %s and does not revive it when ready", (_name, status) => {
    const { result } = renderHook(() => useAiMood());
    emit();
    const previous = result.current.mood;
    expect(previous).not.toBeNull();
    emitStatus(status);
    expect(getActiveAiMood(previous, result.current.status, performance.now())).toBeNull();
    expect(result.current).toMatchObject({ mood: null, stale: false, ...neutral });
    emitStatus();
    expect(result.current).toMatchObject({ mood: null, ...neutral });
    emit(moodResult({ sequence: 2n }));
    expect(result.current.mood?.sequence).toBe(2n);
    expect(result.current.moodLabel).toBe("happy");
  });

  it.each(unavailableStatuses)("keeps incoming results out of filters while %s", (_name, status) => {
    const { result } = renderHook(() => useAiMood());
    emitStatus(status);
    emit();
    expect(result.current).toMatchObject(neutral);
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBeNull();
  });

  it.each(["running", "degraded"] as const)("rejects placeholder results even when %s status reports a ready model", phase => {
    const { result } = renderHook(() => useAiMood());
    emitStatus({ phase });
    emit(moodResult({ modelReady: false }));
    expect(result.current.mood?.modelReady).toBe(false);
    expect(result.current).toMatchObject(neutral);
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBeNull();
  });

  it("keeps real model results usable in degraded status, but still expires them", async () => {
    const { result } = renderHook(() => useAiMood());
    await advance(100);
    emit();
    const receivedAt = performance.now();
    emitStatus({ phase: "degraded", lastError: "temporary inference warning" });
    expect(result.current).toMatchObject({ moodLabel: "happy", workerReady: true, error: "temporary inference warning" });
    expect(result.current.mood?.receivedAt).toBe(receivedAt);
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBe(result.current.mood);
    await advance(3000);
    expect(result.current).toMatchObject({ ...neutral, stale: true });
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBeNull();
    emit(moodResult({ sequence: 2n }));
    expect(result.current).toMatchObject({ moodLabel: "happy", dominantMood: "happy", stale: false });
    expect(result.current.mood).toMatchObject({ sequence: 2n, receivedAt: performance.now() });
    expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBe(result.current.mood);
  });
});

describe("AI mood reset and cleanup", () => {
  it.each(["happy", "sad", "relaxed", "aggressive"] as const)("discards invalid %s scores instead of retaining old data", dimension => {
    const { result } = renderHook(() => useAiMood());
    for (const invalid of [NaN, Infinity, -Infinity, -0.01, 1.01, undefined, null, "0.5"]) {
      emit();
      expect(result.current.mood).not.toBeNull();
      emit(moodResult({ scores: { ...rawScores, [dimension]: invalid as unknown as number } }));
      expect(result.current).toMatchObject({ mood: null, ...neutral });
      expect(getActiveAiMood(result.current.mood, result.current.status, performance.now())).toBeNull();
    }
    emit(moodResult({ sequence: 2n }));
    expect(result.current.mood?.sequence).toBe(2n);
    expect(result.current.moodLabel).toBe("happy");
  });

  it.each([0, 3000])("clears data and staleness immediately on reconnect after %s ms", async age => {
    const { result } = renderHook(() => useAiMood());
    await advance(100);
    emit();
    await advance(age);
    expect(result.current.mood).not.toBeNull();
    expect(result.current.stale).toBe(age > 2500);
    act(() => result.current.selfTest());
    expect(result.current).toMatchObject({ mood: null, stale: false, ...neutral });
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.start).not.toHaveBeenCalled();
    await flush();
    expect(service.start).toHaveBeenCalledTimes(1);
    emitStatus();
    expect(result.current).toMatchObject({ mood: null, ...neutral });
    await advance(3000);
    expect(result.current).toMatchObject({ mood: null, stale: false, ...neutral });
    emit(moodResult({ streamEpoch: 8n, sequence: 1n }));
    expect(result.current).toMatchObject({ moodLabel: "happy", stale: false });
    expect(result.current.mood).toMatchObject({ streamEpoch: 8n, receivedAt: performance.now() });
  });

  it("unsubscribes, disposes the mocked service and clears polling on unmount", async () => {
    const { unmount } = renderHook(() => useAiMood());
    await flush();
    expect(api.createService).toHaveBeenCalledWith({ modelBaseUrl: "/models/audio-ai" });
    expect(api.invoke).toHaveBeenCalledWith("audio_monitor_status");
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    await flush();
    expect(unsubscribeResult).toHaveBeenCalledTimes(1);
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

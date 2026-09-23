// @vitest-environment jsdom
import { StrictMode, useEffect, type PropsWithChildren } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_STALE_MS, useAudioFeatures, type AudioFeatures, type AudioStatus } from "./useAudioFeatures";

const api = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke, isTauri: api.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const features = (sequence = 1): AudioFeatures => ({
  sequence, capturedAtUs: sequence * 1000, rms: 0.4, bass: 0.5, mid: 0.3,
  treble: 0.2, onset: 0.2, centroid: 0.7, energyTrend: 0.1, silence: false,
});
const status = (overrides: Partial<AudioStatus> = {}): AudioStatus => ({
  ...features(), running: true, state: "running", lastError: null,
  sampleRateHz: 48000, channels: 2, capturedFrames: 100, droppedSamples: 0,
  microphoneEnabled: true, microphoneLevel: 0.01, microphoneGate: 0.008, microphoneGain: 1,
  ...overrides,
});
const stopped = () => status({ running: false, state: "stopped" });
const commands = () => api.invoke.mock.calls.map(([command]) => command);
const handlers: Array<(event: { payload: unknown }) => void> = [];
const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
function emit(payload: unknown, index = handlers.length - 1) {
  act(() => handlers[index]({ payload }));
}
async function flush() {
  await act(async () => {
    // Drain the serialized lifecycle and React updates, without advancing timers.
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
  vi.resetAllMocks();
  handlers.length = 0;
  unsubscribes.length = 0;
  api.isTauri.mockReturnValue(true);
  api.listen.mockImplementation(async (_name, handler) => {
    handlers.push(handler);
    const unsubscribe = vi.fn();
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
  api.invoke.mockImplementation(async (command) => command === "stop_audio_monitor" ? stopped() : status());
});
afterEach(async () => {
  cleanup();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("audio lifecycle", () => {
  it("subscribes before invoking start and ignores duplicate starts while busy or running", async () => {
    const subscription = deferred<() => void>();
    const unsubscribe = vi.fn();
    api.listen.mockReturnValueOnce(subscription.promise);
    const { result } = renderHook(useAudioFeatures);
    let first!: Promise<void>;
    act(() => { first = result.current.start(); void result.current.start(); });
    await flush();
    expect(result.current.busy).toBe(true);
    expect(api.listen).toHaveBeenCalledTimes(1);
    expect(api.invoke).not.toHaveBeenCalled();
    await act(async () => { subscription.resolve(unsubscribe); await first; });
    await act(async () => { await result.current.start(); });
    expect(commands()).toEqual(["start_audio_monitor"]);
    expect(result.current).toMatchObject({ running: true, source: "tauri", busy: false, error: null });
    expect(result.current.status?.state).toBe("running");
    await act(async () => { await result.current.stop(); });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("surfaces a subscription failure without starting the backend and permits retry", async () => {
    api.listen.mockRejectedValueOnce(new Error("subscribe failed"));
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await expect(result.current.start()).resolves.toBeUndefined(); });
    expect(api.invoke).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ running: false, source: "off", busy: false, error: "subscribe failed" });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await result.current.start(); });
    expect(result.current.running).toBe(true);
  });

  it("cleans up a rejected start, stays idle without reconnecting, and permits retry", async () => {
    api.invoke.mockRejectedValueOnce("device unavailable");
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await expect(result.current.start()).resolves.toBeUndefined(); });
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ running: false, source: "off", busy: false, stale: false, error: "device unavailable" });
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    expect(result.current.featuresRef.current.centroid).toBe(0.5);
    await advance(5000);
    expect(commands()).toEqual(["start_audio_monitor"]);
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBeNull();
    expect(result.current.running).toBe(true);
  });

  it("serializes deferred start-stop-start and ignores obsolete event callbacks", async () => {
    const starting = deferred<AudioStatus>();
    api.invoke.mockReturnValueOnce(starting.promise);
    const { result } = renderHook(useAudioFeatures);
    let first!: Promise<void>;
    let stopping!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.start(); });
    await flush();
    act(() => { stopping = result.current.stop(); second = result.current.start(); });
    await flush();
    expect(commands()).toEqual(["start_audio_monitor"]);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    emit(features(90), 0);
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    await act(async () => { starting.resolve(status()); await Promise.all([first, stopping, second]); });
    expect(commands()).toEqual(["start_audio_monitor", "stop_audio_monitor", "start_audio_monitor"]);
    expect(result.current).toMatchObject({ running: true, source: "tauri", busy: false });
    emit(features(1), 1);
    const latest = result.current.featuresRef.current;
    emit(features(999), 0);
    expect(result.current.featuresRef.current).toBe(latest);
  });

  it("does not invoke start when a late subscription resolves after stop", async () => {
    const subscription = deferred<() => void>();
    const unsubscribe = vi.fn();
    api.listen.mockReturnValueOnce(subscription.promise);
    const { result } = renderHook(useAudioFeatures);
    let starting!: Promise<void>;
    let stopping!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await flush();
    act(() => { stopping = result.current.stop(); });
    await act(async () => { subscription.resolve(unsubscribe); await Promise.all([starting, stopping]); });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.invoke).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ running: false, busy: false, source: "off" });
  });

  it("stops a backend that starts after unmount before allowing a real remount to start", async () => {
    const starting = deferred<AudioStatus>();
    api.invoke.mockReturnValueOnce(starting.promise);
    const old = renderHook(useAudioFeatures);
    act(() => { void old.result.current.start(); });
    await flush();
    old.unmount();
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const next = renderHook(useAudioFeatures);
    let nextStart!: Promise<void>;
    act(() => { nextStart = next.result.current.start(); });
    await flush();
    expect(commands()).toEqual(["start_audio_monitor"]);
    await act(async () => { starting.resolve(status()); await nextStart; });
    expect(commands()).toEqual(["start_audio_monitor", "stop_audio_monitor", "start_audio_monitor"]);
    emit(features(99), 0);
    expect(next.result.current.lastReceivedAtRef.current).toBeNull();
    expect(next.result.current.running).toBe(true);
    await flush();
    expect(commands().filter(command => command === "stop_audio_monitor")).toHaveLength(1);
  });

  it("survives StrictMode effect replay without duplicate subscriptions or stale cleanup", async () => {
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
    const { result, unmount } = renderHook(() => {
      const audio = useAudioFeatures();
      useEffect(() => { void audio.start(); }, [audio.start]);
      return audio;
    }, { wrapper });
    await flush();
    expect(result.current).toMatchObject({ running: true, source: "tauri", busy: false });
    expect(api.listen).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual(["start_audio_monitor"]);
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    await flush();
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual(["start_audio_monitor", "stop_audio_monitor"]);
  });

  it("keeps an uncertain backend visible after stop rejection and supports an explicit stop retry", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    emit(features());
    api.invoke.mockRejectedValueOnce(new Error("stop failed"));
    await act(async () => { await expect(result.current.stop()).resolves.toBeUndefined(); });
    expect(result.current).toMatchObject({ running: true, source: "tauri", busy: false, stale: true, error: "stop failed" });
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    expect(result.current.featuresRef.current).toMatchObject({ rms: 0, centroid: 0.5 });
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await result.current.stop(); });
    expect(result.current).toMatchObject({ running: false, source: "off", busy: false, stale: false, error: null });
    expect(commands()).toEqual(["start_audio_monitor", "stop_audio_monitor", "stop_audio_monitor"]);
  });

  it("requires confirmed stop before a manual start retry after stop rejection", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    api.invoke.mockRejectedValueOnce("cannot stop");
    await act(async () => { await result.current.stop(); });
    api.invoke.mockRejectedValueOnce("still cannot stop");
    await act(async () => { await expect(result.current.start()).resolves.toBeUndefined(); });
    expect(result.current).toMatchObject({ running: true, source: "tauri", busy: false, error: "still cannot stop" });
    expect(api.listen).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.start(); });
    expect(commands()).toEqual([
      "start_audio_monitor", "stop_audio_monitor", "stop_audio_monitor", "stop_audio_monitor", "start_audio_monitor",
    ]);
    expect(result.current.error).toBeNull();
  });

  it("does not claim stop succeeded if the command returns a running backend", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    api.invoke.mockResolvedValueOnce(status());
    await act(async () => { await result.current.stop(); });
    expect(result.current.running).toBe(true);
    expect(result.current.error).toContain("尚未确认停止");
    await act(async () => { await result.current.stop(); });
    expect(result.current.running).toBe(false);
  });

  it("waits for a deferred stop before starting again and does not report an early stop", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    const stopping = deferred<AudioStatus>();
    api.invoke.mockReturnValueOnce(stopping.promise);
    let stop!: Promise<void>;
    let start!: Promise<void>;
    act(() => { stop = result.current.stop(); start = result.current.start(); });
    await flush();
    expect(result.current).toMatchObject({ running: true, busy: true });
    expect(commands()).toEqual(["start_audio_monitor", "stop_audio_monitor"]);
    await act(async () => { stopping.resolve(stopped()); await Promise.all([stop, start]); });
    expect(commands()).toEqual(["start_audio_monitor", "stop_audio_monitor", "start_audio_monitor"]);
    expect(result.current).toMatchObject({ running: true, busy: false });
  });
});

describe("audio reception and status", () => {
  it("sanitizes finite normalized features and accepts only increasing safe integer sequences", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    emit({ ...features(), capturedAtUs: Infinity, rms: NaN, bass: 2, mid: 1, treble: -1,
      onset: Infinity, centroid: NaN, energyTrend: -20, silence: "false" });
    expect(result.current.featuresRef.current).toEqual({
      sequence: 1, capturedAtUs: 0, rms: 0, bass: 0.5, mid: 0.5, treble: 0,
      onset: 0, centroid: 0.5, energyTrend: -1, silence: true,
    });
    const accepted = result.current.featuresRef.current;
    const receivedAt = result.current.lastReceivedAtRef.current;
    await advance(200);
    for (const sequence of [0, 1, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) emit(features(sequence));
    emit(null);
    expect(result.current.featuresRef.current).toBe(accepted);
    expect(result.current.lastReceivedAtRef.current).toBe(receivedAt);
    emit({ ...features(20), rms: 5, centroid: -1, energyTrend: 8 });
    expect(result.current.featuresRef.current).toMatchObject({ sequence: 20, rms: 1, centroid: 0, energyTrend: 1 });
    expect(result.current.lastReceivedAtRef.current).toBe(performance.now());
  });

  it("uses monotonic local reception age, neutralizes stale data, and recovers without resubscribing", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    emit({ ...features(), capturedAtUs: Number.MAX_SAFE_INTEGER });
    const receivedAt = result.current.lastReceivedAtRef.current;
    vi.setSystemTime(new Date("2040-01-01"));
    await advance(AUDIO_STALE_MS - 1);
    expect(result.current.stale).toBe(false);
    await advance(1);
    expect(result.current).toMatchObject({ stale: true, running: true, source: "tauri", error: null });
    expect(result.current.featuresRef.current.centroid).toBe(0.5);
    expect(result.current.lastReceivedAtRef.current).toBe(receivedAt);
    expect(unsubscribes[0]).not.toHaveBeenCalled();
    emit(features(1));
    expect(result.current.stale).toBe(true);
    emit(features(2));
    expect(result.current.stale).toBe(false);
    expect(result.current.lastReceivedAtRef.current).toBe(performance.now());
    expect(api.listen).toHaveBeenCalledTimes(1);
    expect(commands().filter(command => command === "start_audio_monitor")).toHaveLength(1);
  });

  it("marks a running backend with no first event stale, not failed", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    await advance(AUDIO_STALE_MS);
    expect(result.current).toMatchObject({ running: true, stale: true, error: null });
    expect(unsubscribes[0]).not.toHaveBeenCalled();
    emit(features());
    expect(result.current.stale).toBe(false);
  });

  it.each(["failed", "stopped"] as const)("handles confirmed %s status and allows manual restart", async state => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    emit(features(5));
    const lastError = state === "failed" ? "device removed" : null;
    api.invoke.mockResolvedValueOnce(status({ running: false, state, lastError }));
    await advance(1000);
    expect(result.current).toMatchObject({ running: false, source: "off", stale: false, busy: false, error: lastError });
    expect(result.current.status).toMatchObject({ state, lastError });
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    expect(result.current.featuresRef.current).toMatchObject({ rms: 0, centroid: 0.5, silence: true });
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    emit(features(9), 0);
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    await advance(5000);
    expect(commands()).toEqual(["start_audio_monitor", "audio_monitor_status"]);
    await act(async () => { await result.current.start(); });
    emit(features(1));
    expect(result.current).toMatchObject({ running: true, error: null });
    expect(result.current.featuresRef.current.sequence).toBe(1);
  });

  it("handles a failed state returned directly by start without creating polling timers", async () => {
    api.invoke.mockResolvedValueOnce(status({ running: false, state: "failed", lastError: "init failed" }));
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    expect(result.current).toMatchObject({ running: false, source: "off", busy: false, error: "init failed" });
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces query rejection without claiming a backend failure and recovers on the next query", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    api.invoke.mockRejectedValueOnce("status unavailable");
    await advance(1000);
    expect(result.current).toMatchObject({ running: true, source: "tauri", error: "status unavailable" });
    expect(unsubscribes[0]).not.toHaveBeenCalled();
    emit(features());
    expect(result.current.stale).toBe(false);
    await advance(1000);
    expect(result.current.error).toBeNull();
    expect(commands().filter(command => command === "start_audio_monitor")).toHaveLength(1);
  });

  it("never overlaps status requests and ignores a late failed status from an older session", async () => {
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    const query = deferred<AudioStatus>();
    api.invoke.mockReturnValueOnce(query.promise);
    await advance(5000);
    expect(commands().filter(command => command === "audio_monitor_status")).toHaveLength(1);
    await act(async () => { await result.current.stop(); await result.current.start(); });
    await advance(2000);
    expect(commands().filter(command => command === "audio_monitor_status")).toHaveLength(1);
    await act(async () => { query.resolve(status({ running: false, state: "failed", lastError: "old failure" })); });
    expect(result.current).toMatchObject({ running: true, source: "tauri", error: null });
    expect(unsubscribes[1]).not.toHaveBeenCalled();
    await advance(1000);
    expect(commands().filter(command => command === "audio_monitor_status")).toHaveLength(2);
  });

  it("also gates polling across real remounts and discards a late query rejection", async () => {
    const old = renderHook(useAudioFeatures);
    await act(async () => { await old.result.current.start(); });
    const query = deferred<AudioStatus>();
    api.invoke.mockReturnValueOnce(query.promise);
    await advance(1000);
    old.unmount();
    const next = renderHook(useAudioFeatures);
    await act(async () => { await next.result.current.start(); });
    await advance(2000);
    expect(commands().filter(command => command === "audio_monitor_status")).toHaveLength(1);
    await act(async () => { query.reject("obsolete query failed"); });
    expect(next.result.current).toMatchObject({ running: true, source: "tauri", error: null });
    await advance(1000);
    expect(commands().filter(command => command === "audio_monitor_status")).toHaveLength(2);
  });

  it("preserves browser simulation, reception timestamps and teardown", async () => {
    api.isTauri.mockReturnValue(false);
    const { result } = renderHook(useAudioFeatures);
    await act(async () => { await result.current.start(); });
    expect(result.current).toMatchObject({ running: true, source: "simulation", busy: false, error: null });
    await advance(33);
    expect(result.current.featuresRef.current.sequence).toBe(1);
    expect(result.current.lastReceivedAtRef.current).toBe(performance.now());
    const { bass, mid, treble } = result.current.featuresRef.current;
    expect(bass + mid + treble).toBeCloseTo(1);
    await advance(2000);
    expect(result.current.stale).toBe(false);
    await act(async () => { await result.current.stop(); });
    expect(result.current).toMatchObject({ running: false, source: "off", stale: false });
    expect(result.current.lastReceivedAtRef.current).toBeNull();
    expect(result.current.featuresRef.current.centroid).toBe(0.5);
    expect(api.invoke).not.toHaveBeenCalled();
    expect(api.listen).not.toHaveBeenCalled();
  });
});

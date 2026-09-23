import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiMood, AiMoodHandle } from "./ai/useAiMood";
import type { UniformValues } from "./gl/FilterRenderer";
import App from "./App";

const state = vi.hoisted(() => ({
  now: 1000,
  mood: null as AiMood | null,
  ready: true,
  running: true,
  silence: false,
  draw: vi.fn(),
  dispose: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("../packages/audio-ai/src", () => ({ createTauriAudioMoodService: vi.fn() }));
vi.mock("./ai/useAiMood", async importOriginal => {
  const actual = await importOriginal<typeof import("./ai/useAiMood")>();
  return {
    ...actual,
    useAiMood: (): AiMoodHandle => ({
      mood: state.mood, moodLabel: "happy", moodState: "bright", dominantMood: "happy",
      workerReady: state.ready, stale: false, error: null, selfTest: vi.fn(),
      status: { phase: state.ready ? "running" : "failed", modelReady: state.ready, backendConnected: state.ready, lastError: null },
    }),
  };
});
vi.mock("./audio/useAudioFeatures", () => ({
  AUDIO_STALE_MS: 1000,
  useAudioFeatures: () => ({
    featuresRef: audioFeaturesRef,
    lastReceivedAtRef: audioReceivedRef,
    running: state.running, source: "tauri", status: null, busy: false, error: null, stale: false,
    start: vi.fn(), stop: vi.fn(),
  }),
}));
vi.mock("./useCamera", () => ({ useCamera: () => ({ cameras: [], error: null, busy: false, retry: vi.fn() }) }));
vi.mock("./components/RmsWaveform", () => ({ RmsWaveform: () => null }));
vi.mock("./gl/FilterRenderer", () => ({
  FilterRenderer: class {
    videoFrames = 0;
    warning = "";
    constructor() { state.construct(); }
    render(_video: HTMLVideoElement, values: UniformValues) { state.draw({ ...values }); return true; }
    dispose() { state.dispose(); }
  },
}));

const audioFeaturesRef = {
  get current() {
    return { sequence: 1, capturedAtUs: 0, rms: state.silence ? 0 : 0.2, bass: 0.4, mid: 0.3, treble: 0.3,
      onset: 0, centroid: 0.5, energyTrend: 0, silence: state.silence };
  },
};
const audioReceivedRef = { get current() { return state.now; } };
let pendingFrame: FrameRequestCallback | null = null;
const happyRelaxed = (): AiMood => ({
  happy: 0.95, sad: 0.05, relaxed: 0.95, aggressive: 0.1,
  rawHappy: 0.3, rawSad: 0.5, valence: 0.95, confidence: 0,
  streamEpoch: 1n, sequence: 1n, inferenceMs: 10, modelReady: true, silent: false, receivedAt: state.now,
});
function frame(seconds: number, refreshMood = true) {
  act(() => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      state.now += 1000 / 60;
      if (refreshMood && state.mood) state.mood.receivedAt = state.now;
      const callback = pendingFrame;
      pendingFrame = null;
      callback?.(state.now);
    }
  });
}
function uniforms(): UniformValues { return state.draw.mock.lastCall![0]; }
function selectMode(name: string) { fireEvent.click(screen.getByRole("radio", { name })); }

beforeEach(() => {
  vi.clearAllMocks();
  state.now = 1000;
  state.ready = true;
  state.running = true;
  state.silence = false;
  state.mood = happyRelaxed();
  pendingFrame = null;
  vi.spyOn(performance, "now").mockImplementation(() => state.now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pendingFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { pendingFrame = null; });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("filter mode integration", () => {
  it("uses latest AI scores in rendering only after selecting AI mode and preserves the preview", () => {
    render(<App />);
    frame(5);
    expect((screen.getByRole("radio", { name: "默认模式" }) as HTMLInputElement).checked).toBe(true);
    expect(uniforms()).toMatchObject({ uLookDark: 1, uLookCalm: 0, uLookBright: 0, uTemperature: 0, uSoftClip: 0, uSaturation: 1, uGammaMid: 1 });
    const video = document.querySelector("video");
    const canvas = document.querySelector("canvas.preview");
    selectMode("AI 模式");
    frame(8);
    expect(uniforms().uLookBright).toBeGreaterThan(0.1);
    expect(uniforms().uLookCalm).toBeGreaterThan(0.1);
    expect(uniforms().uTemperature).toBeLessThan(0);
    expect(uniforms().uSoftClip).toBe(1);
    expect(uniforms().uSaturation).toBeGreaterThan(1.05);
    expect(uniforms().uGammaMid).toBeGreaterThan(1.1);
    expect(screen.getByRole("status").textContent).toContain("AI 混合氛围");
    expect(state.construct).toHaveBeenCalledTimes(1);
    expect(state.dispose).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBe(video);
    expect(document.querySelector("canvas.preview")).toBe(canvas);
    fireEvent.click(screen.getByRole("checkbox", { name: "A/B 原图" }));
    frame(0.1);
    expect(uniforms().uBypass).toBe(1);
    selectMode("默认模式");
    frame(2);
    expect(uniforms()).toMatchObject({ uLookDark: 1, uLookCalm: 0, uLookBright: 0, uTemperature: 0, uSoftClip: 0, uSaturation: 1, uGammaMid: 1 });
    expect(state.construct).toHaveBeenCalledTimes(1);
  });

  it.each(["silence", "stopped", "failed", "expired"] as const)("releases AI influence on %s without changing the selected mode", reason => {
    const view = render(<App />);
    selectMode("AI 模式");
    frame(8);
    expect(uniforms().uLookBright).toBeGreaterThan(0.1);
    if (reason === "silence") state.silence = true;
    if (reason === "stopped") state.running = false;
    if (reason === "failed") state.ready = false;
    view.rerender(<App />);
    frame(20, reason !== "expired");
    expect((screen.getByRole("radio", { name: "AI 模式" }) as HTMLInputElement).checked).toBe(true);
    expect(uniforms().uLookBright).toBeCloseTo(0, 5);
    expect(uniforms().uLookCalm).toBeCloseTo(0, 5);
    expect(uniforms().uTemperature).toBeCloseTo(0, 5);
    expect(uniforms().uBloom).toBeCloseTo(0, 5);
    expect(uniforms().uSaturation).toBeCloseTo(1, 5);
    expect(uniforms().uGammaMid).toBeCloseTo(1, 5);
    expect(state.construct).toHaveBeenCalledTimes(1);
  });
});

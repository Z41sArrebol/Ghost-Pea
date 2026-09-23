import { describe, expect, it } from "vitest";
import type { MoodScores } from "../../packages/audio-ai/src";
import type { AudioFeatures } from "../audio/useAudioFeatures";
import { OUTPUT_LIMITS, ParameterOrchestrator, type RenderParameters } from "../params/orchestrator";
import { DEFAULT_PARAMS, type ParamValues } from "../params/schema";
import { AiFilterController, type FilterMode } from "./AiFilterController";

const SILENT: AudioFeatures = {
  sequence: 0, capturedAtUs: 0, rms: 0, bass: 0, mid: 0, treble: 0,
  onset: 0, centroid: 0.5, energyTrend: 0, silence: true,
};
const LOUD: AudioFeatures = { ...SILENT, rms: 1, bass: 0.6, treble: 0.4, onset: 1, centroid: 1, silence: false };
const HAPPY: MoodScores = { happy: 1, sad: 0, relaxed: 0, aggressive: 0 };
const SAD: MoodScores = { happy: 0, sad: 1, relaxed: 0, aggressive: 0 };
const RELAXED: MoodScores = { happy: 0, sad: 0, relaxed: 1, aggressive: 0 };
const AGGRESSIVE: MoodScores = { happy: 0, sad: 0, relaxed: 0, aggressive: 1 };
const KEYS = Object.keys(OUTPUT_LIMITS) as (keyof RenderParameters)[];
const BASE = new ParameterOrchestrator(DEFAULT_PARAMS).update(DEFAULT_PARAMS, SILENT, false, 0);

function advance(
  controller: AiFilterController,
  mood: MoodScores | null,
  mode: FilterMode = "ai",
  base = BASE,
  params: ParamValues = DEFAULT_PARAMS,
  frames = 1200,
  dt = 1 / 60,
): RenderParameters {
  let result = controller.update(base, params, mode, mood, 0);
  for (let frame = 0; frame < frames; frame++) result = controller.update(base, params, mode, mood, dt);
  return { ...result };
}

function expectBounded(result: RenderParameters) {
  for (const key of KEYS) {
    expect(Number.isFinite(result[key])).toBe(true);
    expect(result[key]).toBeGreaterThanOrEqual(OUTPUT_LIMITS[key][0] - 1e-12);
    expect(result[key]).toBeLessThanOrEqual(OUTPUT_LIMITS[key][1] + 1e-12);
  }
  expect(result.lookDark + result.lookCalm + result.lookBright
    + result.lookHappy + result.lookSad + result.lookRelaxed + result.lookAggressive).toBeLessThanOrEqual(1 + 1e-12);
}

describe("AiFilterController", () => {
  it("passes default mode through unchanged across audio, silence, presets and AI inputs", () => {
    const controller = new AiFilterController();
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    for (let frame = 0; frame < 300; frame++) {
      const params = frame < 100 ? DEFAULT_PARAMS : { ...DEFAULT_PARAMS, lookDark: 0, lookCalm: 1 };
      const base = orchestrator.update(params, frame % 2 ? LOUD : SILENT, frame < 250, 1 / 60);
      expect(controller.update(base, orchestrator.params, "default", frame % 2 ? HAPPY : SAD, 1 / 60)).toEqual(base);
    }
  });

  it("maps happy, sad, relaxed and aggressive to distinct continuous directions", () => {
    const happy = advance(new AiFilterController(), HAPPY);
    const sad = advance(new AiFilterController(), SAD);
    const relaxed = advance(new AiFilterController(), RELAXED);
    const aggressive = advance(new AiFilterController(), AGGRESSIVE);
    expect(happy.temperature).toBeLessThan(0);
    expect(happy.brightness).toBeGreaterThan(BASE.brightness);
    expect(happy.saturation).toBeGreaterThan(1);
    expect(happy.gammaMid).toBeGreaterThan(1);
    expect(happy.lookHappy).toBeGreaterThan(0);
    expect(sad.temperature).toBeGreaterThan(0);
    expect(sad.brightness).toBeLessThan(BASE.brightness);
    expect(sad.saturation).toBeLessThan(1);
    expect(sad.gammaMid).toBeLessThan(1);
    expect(sad.lookSad).toBeGreaterThan(0);
    expect(relaxed.lookRelaxed).toBeGreaterThan(0);
    expect(relaxed.contrast).toBeLessThan(BASE.contrast);
    expect(relaxed.bloom).toBeGreaterThan(0);
    expect(aggressive.contrast).toBeGreaterThan(BASE.contrast);
    expect(aggressive.grain).toBeGreaterThan(BASE.grain);
    expect(aggressive.lookAggressive).toBeGreaterThan(0);
    [happy, sad, relaxed, aggressive].forEach(expectBounded);
  });

  it("makes the four moods clearly different within five seconds at default intensity", () => {
    const results = [HAPPY, SAD, RELAXED, AGGRESSIVE].map(mood =>
      advance(new AiFilterController(), mood, "ai", BASE, DEFAULT_PARAMS, 300));
    const [happy, sad, relaxed, aggressive] = results;
    expect(happy.brightness).toBeGreaterThan(1.02);
    expect(happy.temperature).toBeLessThan(-0.2);
    expect(happy.saturation).toBeGreaterThan(1.15);
    expect(happy.lookHappy).toBeGreaterThan(0.35);
    expect(sad.brightness).toBeLessThan(0.88);
    expect(sad.temperature).toBeGreaterThan(0.2);
    expect(sad.saturation).toBeLessThan(0.85);
    expect(sad.lookSad).toBeGreaterThan(0.35);
    expect(relaxed.contrast).toBeLessThan(1.0);
    expect(relaxed.bloom).toBeGreaterThan(0.12);
    expect(relaxed.lookRelaxed).toBeGreaterThan(0.35);
    expect(relaxed.gammaMid).toBeGreaterThan(1.05);
    expect(aggressive.contrast).toBeGreaterThan(1.24);
    expect(aggressive.grain).toBeGreaterThan(BASE.grain + 0.02);
    expect(aggressive.lookAggressive).toBeGreaterThan(0.35);
    results.forEach(expectBounded);
  });

  it("clamps exaggerated mixed moods at extreme manual settings", () => {
    for (const intensity of [0, 0.8, 1]) {
      for (const high of [false, true]) {
        const params = { ...DEFAULT_PARAMS, intensity, baseContrast: high ? 2 : 0.5,
          brightness: high ? 1.5 : 0.5, grainBase: high ? 0.15 : 0 };
        const base = new ParameterOrchestrator(params).update(params, SILENT, false, 0);
        const result = advance(new AiFilterController(), { happy: 1, sad: 1, relaxed: 1, aggressive: 1 }, "ai", base, params);
        expectBounded(result);
      }
    }
  });

  it("mixes happy and relaxed without choosing a winning label or overwriting the user's style", () => {
    const params = Object.freeze({ ...DEFAULT_PARAMS });
    const base = Object.freeze({ ...BASE });
    const mood = Object.freeze({ ...HAPPY, relaxed: 1 });
    const mixed = advance(new AiFilterController(), mood, "ai", base, params);
    expect(mixed.lookHappy).toBeGreaterThan(0.18);
    expect(mixed.lookRelaxed).toBeGreaterThan(0.18);
    expect(mixed.lookDark).toBeGreaterThan(0.45);
    expect(mixed.lookDark).toBeLessThan(0.6);
    expectBounded(mixed);
    expect(params).toEqual(DEFAULT_PARAMS);
    expect(base).toEqual(BASE);
  });

  it("does not force weak or zero evidence into a full-strength look", () => {
    const weak = advance(new AiFilterController(), { happy: 0.5, sad: 0.5, relaxed: 0.5, aggressive: 0.5 });
    expect(weak).toEqual(BASE);
    const zero = advance(new AiFilterController(), { happy: 0, sad: 0, relaxed: 0, aggressive: 0 });
    expect(zero).toEqual(BASE);
  });

  it("changes slowly on entry and uses the current rendered values when the mood changes", () => {
    const controller = new AiFilterController();
    controller.update(BASE, DEFAULT_PARAMS, "default", null, 1 / 60);
    const first = { ...controller.update(BASE, DEFAULT_PARAMS, "ai", HAPPY, 1 / 60) };
    expect(first.lookHappy).toBeGreaterThan(0);
    expect(first.lookHappy).toBeLessThanOrEqual(0.18 / 60);
    expect(first.brightness - BASE.brightness).toBeLessThanOrEqual(0.05 / 60 + 1e-12);
    const before = advance(controller, HAPPY);
    const next = controller.update(BASE, DEFAULT_PARAMS, "ai", SAD, 1 / 60);
    expect(next.lookSad).toBeGreaterThan(0);
    expect(Math.abs(next.temperature - before.temperature)).toBeLessThanOrEqual(0.16 / 60 + 1e-12);
  });

  it("keeps LUT sums and output bounds valid while rapidly alternating conflicting moods", () => {
    const controller = new AiFilterController();
    let previous = { ...BASE };
    for (let frame = 0; frame < 1200; frame++) {
      const mood = frame % 60 < 30 ? { ...HAPPY, relaxed: 1 } : { ...SAD, aggressive: 1 };
      const result = controller.update(BASE, DEFAULT_PARAMS, "ai", mood, 1 / 60);
      expectBounded(result);
      expect(Math.abs(result.brightness - previous.brightness)).toBeLessThanOrEqual(0.05 / 60 + 1e-12);
      expect(Math.abs(result.contrast - previous.contrast)).toBeLessThanOrEqual(0.12 / 60 + 1e-12);
      expect(Math.abs(result.saturation - previous.saturation)).toBeLessThanOrEqual(0.12 / 60 + 1e-12);
      for (const key of ["lookDark", "lookCalm", "lookBright", "lookHappy", "lookSad", "lookRelaxed", "lookAggressive"] as const) {
        expect(Math.abs(result[key] - previous[key])).toBeLessThanOrEqual(0.18 / 60 + 1e-12);
      }
      previous = { ...result };
    }
  });

  it("returns to the static style without replaying beats when AI input is unavailable", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    for (let i = 0; i < 300; i++) orchestrator.update(DEFAULT_PARAMS, LOUD, true, 1 / 60);
    const loudBase = { ...orchestrator.update(DEFAULT_PARAMS, LOUD, true, 1 / 60) };
    const controller = new AiFilterController();
    const before = advance(controller, HAPPY, "ai", loudBase);
    const first = { ...controller.update(loudBase, DEFAULT_PARAMS, "ai", null, 1 / 60) };
    expect(first.lookHappy).toBeGreaterThan(0);
    expect(first.lookHappy).toBeLessThan(before.lookHappy);
    const result = advance(controller, null, "ai", loudBase);
    for (const key of KEYS) expect(result[key]).toBeCloseTo(BASE[key], 5);
  });

  it("keeps a moderate share of beat-driven contrast breathing in AI mode", () => {
    const base = { ...BASE, contrast: BASE.contrast + 0.3 };
    const result = advance(new AiFilterController(), { happy: 0.5, sad: 0.5, relaxed: 0, aggressive: 0 }, "ai", base);
    expect(result.contrast - BASE.contrast).toBeCloseTo(0.3 * 0.4, 6);
  });

  it("crossfades back to default, then restores exact default behavior", () => {
    const controller = new AiFilterController();
    const before = advance(controller, HAPPY);
    const first = { ...controller.update(BASE, DEFAULT_PARAMS, "default", null, 1 / 60) };
    expect(first.lookHappy).toBeGreaterThan(0);
    expect(first.lookHappy).toBeLessThan(before.lookHappy);
    const restored = advance(controller, null, "default", BASE, DEFAULT_PARAMS, 120);
    expect(restored).toEqual(BASE);
    const changed = { ...BASE, contrast: 1.6 };
    expect(controller.update(changed, DEFAULT_PARAMS, "default", HAPPY, 1 / 60)).toEqual(changed);
  });

  it("can reenter AI during the return transition without restarting from a preset", () => {
    const controller = new AiFilterController();
    advance(controller, HAPPY);
    const returning = advance(controller, null, "default", BASE, DEFAULT_PARAMS, 20);
    const reentered = controller.update(BASE, DEFAULT_PARAMS, "ai", RELAXED, 1 / 60);
    expect(Math.abs(reentered.lookRelaxed - returning.lookRelaxed)).toBeLessThanOrEqual(0.18 / 60 + 1e-12);
    expectBounded(reentered);
  });

  it("honors global intensity zero and the bloom switch", () => {
    const off = { ...DEFAULT_PARAMS, intensity: 0 };
    expect(advance(new AiFilterController(), HAPPY, "ai", BASE, off)).toEqual(BASE);
    const controller = new AiFilterController();
    advance(controller, RELAXED);
    const disabled = controller.update(BASE, { ...DEFAULT_PARAMS, bloomEnabled: 0 }, "ai", RELAXED, 1 / 60);
    expect(disabled.bloom).toBe(0);
    expect(disabled.bloomWarm).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])("does not advance AI transitions with invalid delta %s", (dt) => {
    const controller = new AiFilterController();
    const before = advance(controller, HAPPY, "ai", BASE, DEFAULT_PARAMS, 10);
    expect(controller.update(BASE, DEFAULT_PARAMS, "ai", SAD, dt)).toEqual(before);
  });

  it("caps long frame deltas and remains consistent at 30 and 60 FPS", () => {
    const left = new AiFilterController();
    const right = new AiFilterController();
    expect(left.update(BASE, DEFAULT_PARAMS, "ai", HAPPY, 100)).toEqual(right.update(BASE, DEFAULT_PARAMS, "ai", HAPPY, 0.1));
    const at30 = advance(new AiFilterController(), HAPPY, "ai", BASE, DEFAULT_PARAMS, 90, 1 / 30);
    const at60 = advance(new AiFilterController(), HAPPY, "ai", BASE, DEFAULT_PARAMS, 180, 1 / 60);
    for (const key of KEYS) expect(at30[key]).toBeCloseTo(at60[key], 3);
  });
});

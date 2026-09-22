import { describe, expect, it } from "vitest";
import type { AudioFeatures } from "../audio/useAudioFeatures";
import { ParameterOrchestrator, rmsToVisualLevel, smoothToward, type RenderParameters } from "./orchestrator";
import { THEME_PRESETS } from "./presets";
import { DEFAULT_PARAMS, PARAM_DEFS, parseParams, type ParamValues } from "./schema";

const SILENT: AudioFeatures = {
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
const LOUD: AudioFeatures = { ...SILENT, rms: 1, bass: 1, treble: 1, onset: 1, centroid: 1, silence: false };
const RATES = { contrast: 0.8, brightness: 0.4, temperature: 0.8, grain: 0.15, bloom: 0.8, bloomWarm: 0.5 };
const BOUNDS: Record<keyof RenderParameters, [number, number]> = {
  contrast: [0.5, 2], brightness: [0.5, 1.5], temperature: [-1, 1],
  shadowCool: [0, 1], highlightThr: [0.3, 0.9], vignette: [0, 1],
  grain: [0, 0.15], bloom: [0, 0.6], bloomWarm: [0, 0.35],
  lookDark: [0, 1], lookCalm: [0, 1], lookBright: [0, 1],
};

function params(overrides: ParamValues = {}): ParamValues {
  return parseParams(overrides, DEFAULT_PARAMS);
}

function advance(
  orchestrator: ParameterOrchestrator,
  target = DEFAULT_PARAMS,
  features = LOUD,
  available = true,
  frames = 300,
  dt = 1 / 60,
): RenderParameters {
  let result = orchestrator.update(target, features, available, 0);
  for (let i = 0; i < frames; i++) result = orchestrator.update(target, features, available, dt);
  return result;
}

function expectBounded(result: RenderParameters): void {
  for (const key of Object.keys(BOUNDS) as (keyof RenderParameters)[]) {
    expect(Number.isFinite(result[key])).toBe(true);
    expect(result[key]).toBeGreaterThanOrEqual(BOUNDS[key][0]);
    expect(result[key]).toBeLessThanOrEqual(BOUNDS[key][1]);
  }
  expect(result.lookDark + result.lookCalm + result.lookBright).toBeLessThanOrEqual(1 + 1e-9);
}

function expectRate(previous: RenderParameters, current: RenderParameters, dt: number): void {
  for (const key of Object.keys(RATES) as (keyof typeof RATES)[]) {
    expect(Math.abs(current[key] - previous[key])).toBeLessThanOrEqual(RATES[key] * dt + 1e-12);
  }
}

describe("parseParams", () => {
  it("keeps omitted values, ignores unknown keys, and does not mutate either input", () => {
    const current = Object.freeze(params());
    const input = Object.freeze({ brightness: 1.2, unknown: "ignored", constructor: "ignored" });
    const result = parseParams(input, current);
    expect(result).toEqual({ ...current, brightness: 1.2 });
    expect(result).not.toBe(current);
    expect(current.brightness).toBe(DEFAULT_PARAMS.brightness);
    expect(input.brightness).toBe(1.2);
  });

  it.each([null, [], 1, "{}", true, undefined, new Date(), new Number(1)])("rejects non-plain input %s", (input) => {
    expect(() => parseParams(input, DEFAULT_PARAMS)).toThrow(/JSON 对象/);
  });

  it("accepts null-prototype dictionaries but rejects custom prototypes and accessors", () => {
    expect(parseParams(Object.assign(Object.create(null), { brightness: 1.1 }), DEFAULT_PARAMS).brightness).toBe(1.1);
    expect(() => parseParams(Object.create({ brightness: 1.1 }), DEFAULT_PARAMS)).toThrow(/JSON 对象/);
    expect(() => parseParams({ get brightness() { throw new Error("不应执行 getter"); } }, DEFAULT_PARAMS)).toThrow(/brightness/);
  });

  it.each([NaN, Infinity, -Infinity, "1.1", true, false, null, undefined, {}, [], new Number(1)])("does not coerce %s", (value) => {
    expect(() => parseParams({ brightness: value }, DEFAULT_PARAMS)).toThrow(/brightness.*有限数字/);
  });

  it("rejects a mixed valid/invalid import atomically with an actionable error", () => {
    const current = params();
    const previous = { ...current };
    expect(() => parseParams({ brightness: 1.1, rmsAttack: 0 }, current)).toThrow(/rmsAttack.*0.01.*1.*未修改任何参数/);
    expect(current).toEqual(previous);
  });

  it.each(PARAM_DEFS)("validates inclusive schema boundaries for $key", (def) => {
    const current = params({ lookDark: 0, lookCalm: 0, lookBright: 0 });
    if (def.kind === "switch") {
      for (const value of [0, 1]) expect(parseParams({ [def.key]: value }, current)[def.key]).toBe(value);
      for (const value of [-1, 0.5, 2, true, "1"]) {
        expect(() => parseParams({ [def.key]: value }, current)).toThrow(/数字 0 或 1/);
      }
    } else {
      for (const value of [def.min, def.max]) expect(parseParams({ [def.key]: value }, current)[def.key]).toBe(value);
      for (const value of [def.min - def.step, def.max + def.step]) {
        expect(() => parseParams({ [def.key]: value }, current)).toThrow(def.key);
      }
    }
  });

  it("rejects excess combined look weight, including retained values", () => {
    expect(() => parseParams({ lookCalm: 0.1 }, DEFAULT_PARAMS)).toThrow(/合计不能超过 1.*同时调低/);
    expect(params({ lookDark: 0.2, lookCalm: 0.3, lookBright: 0.5 }).lookBright).toBe(0.5);
    expect(params({ lookDark: 0, lookCalm: 0, lookBright: 0 }).lookDark).toBe(0);
    expect(() => params({ lookDark: 0.5, lookCalm: 0.5, lookBright: 1e-10 })).not.toThrow();
    expect(() => params({ lookDark: 0.5, lookCalm: 0.5, lookBright: 1e-7 })).toThrow(/合计/);
  });
});

describe("schema and presets", () => {
  it("has one valid default for each definition", () => {
    const keys = PARAM_DEFS.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(DEFAULT_PARAMS).sort()).toEqual([...keys].sort());
    expect(parseParams(DEFAULT_PARAMS, DEFAULT_PARAMS)).toEqual(DEFAULT_PARAMS);
    expect(DEFAULT_PARAMS).toMatchObject({ bloomEnabled: 1, lookDark: 1, lookCalm: 0, lookBright: 0 });
  });

  it("hides only the look sliders and exposes the numeric bloom switch", () => {
    expect(PARAM_DEFS.filter((def) => def.kind === "slider" && def.hidden).map((def) => def.key))
      .toEqual(["lookDark", "lookCalm", "lookBright"]);
    expect(PARAM_DEFS.find((def) => def.key === "bloomEnabled"))
      .toEqual({ kind: "switch", key: "bloomEnabled", group: "filter", label: "高光扩散" });
  });

  it.each(THEME_PRESETS)("$key selects one style without changing performance or timing", (preset) => {
    const current = params({ bloomEnabled: 0, rmsAttack: 0.6, silenceFallback: 0 });
    const result = parseParams(preset.values, current);
    const lookKeys = ["lookDark", "lookCalm", "lookBright"];
    expect(lookKeys.map((key) => result[key])).toEqual(lookKeys.map((key) => key.toLowerCase() === `look${preset.key}` ? 1 : 0));
    expect(result.bloomEnabled).toBe(0);
    expect(result.rmsAttack).toBe(0.6);
    expect(result.silenceFallback).toBe(0);
    expect(preset.values).not.toHaveProperty("bloomEnabled");
    for (const key of Object.keys(preset.values)) {
      const def = PARAM_DEFS.find((entry) => entry.key === key);
      expect(def).toBeDefined();
      expect(def?.group).not.toBe("orchestrator");
      expect(result[key]).toBe(preset.values[key]);
    }
  });
});

describe("smoothToward", () => {
  it("uses attack when rising and release when falling", () => {
    expect(smoothToward(0, 1, 0.05, 0.05, 0.5)).toBeCloseTo(1 - Math.exp(-1));
    expect(smoothToward(1, 0, 0.05, 0.05, 0.5)).toBeCloseTo(Math.exp(-0.1));
  });

  it.each([0, -0.1, NaN, Infinity, -Infinity])("skips invalid delta %s", (dt) => {
    expect(smoothToward(0.5, 1, dt, 0.05, 0.5)).toBe(0.5);
  });

  it("caps elapsed time and keeps invalid times or samples finite", () => {
    expect(smoothToward(0, 1, 10, 0.05, 0.5)).toBe(smoothToward(0, 1, 0.1, 0.05, 0.5));
    expect(Number.isFinite(smoothToward(0, 1, 0.05, 0, NaN))).toBe(true);
    expect(smoothToward(0.5, NaN, 0.05, 0.05, 0.5)).toBe(0.5);
    expect(Number.isFinite(smoothToward(NaN, 1, 0.05, 0.05, 0.5))).toBe(true);
  });
});

describe("rmsToVisualLevel", () => {
  it.each([-1, 0, 0.0005, 0.001, NaN, Infinity, -Infinity])("keeps silence or invalid RMS %s at zero", (rms) => {
    expect(rmsToVisualLevel(rms)).toBe(0);
  });

  it.each([
    [0.02, 0.4336766652, 3],
    [0.2, 0.7670099986, 6],
    [1, 1, 8],
    [2, 1, 8],
  ])("maps RMS %s to level %s and %s of eight meter rows", (rms, level, rows) => {
    expect(rmsToVisualLevel(rms)).toBeCloseTo(level, 8);
    expect(Math.round(rmsToVisualLevel(rms) * 8)).toBe(rows);
  });

  it("rises continuously from the silence floor without flattening normal music", () => {
    const levels = [0.001, 0.001001, 0.01, 0.015, 0.02, 0.03, 0.1, 0.2, 0.5, 1].map(rmsToVisualLevel);
    expect(levels[1]).toBeLessThan(0.001);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThan(levels[i - 1]);
      expect(levels[i]).toBeLessThanOrEqual(1);
    }
  });
});

describe("ParameterOrchestrator", () => {
  it("starts from the selected static grade with neutral dynamics and intentional grain", () => {
    const initial = parseParams(THEME_PRESETS[1].values, DEFAULT_PARAMS);
    const orchestrator = new ParameterOrchestrator(initial);
    expect(orchestrator.features).toEqual({ rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0.5 });
    expect(orchestrator.update(initial, LOUD, true, 0)).toEqual({
      contrast: initial.baseContrast, brightness: initial.brightness, temperature: 0,
      shadowCool: initial.shadowCool, highlightThr: initial.highlightThr, vignette: initial.vignette,
      grain: initial.grainBase, bloom: 0, bloomWarm: 0,
      lookDark: 0, lookCalm: 1, lookBright: 0,
    });
    expect(orchestrator.params).not.toBe(initial);
  });

  it("keeps exposed objects stable and smooths all continuous parameters with tau 0.2", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const features = orchestrator.features;
    const smoothedParams = orchestrator.params;
    const next = params({ brightness: 1.3, mapRmsGlow: 2, intensity: 0, lookDark: 0, lookCalm: 1 });
    advance(orchestrator, next, SILENT, false, 6, 0.1);
    expect(orchestrator.features).toBe(features);
    expect(orchestrator.params).toBe(smoothedParams);
    for (const key of ["brightness", "mapRmsGlow", "intensity", "lookDark", "lookCalm"]) {
      expect(smoothedParams[key]).toBeCloseTo(next[key] + (DEFAULT_PARAMS[key] - next[key]) * Math.exp(-3), 10);
    }
    expect(DEFAULT_PARAMS.lookDark).toBe(1);
  });

  it("applies timing and switches immediately, without smoothing them", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const next = params({ rmsAttack: 0.5, rmsRelease: 1.5, silenceFallback: 0, bloomEnabled: 0 });
    const result = orchestrator.update(next, LOUD, true, 0.01);
    expect(orchestrator.params).toMatchObject({ rmsAttack: 0.5, rmsRelease: 1.5, silenceFallback: 0, bloomEnabled: 0 });
    expect(orchestrator.features.rms).toBeCloseTo(1 - Math.exp(-0.01 / 0.5));
    expect(result.bloom).toBe(0);
    expect(result.bloomWarm).toBe(0);
  });

  it.each([0, 1])("always releases unavailable audio even with silenceFallback=%s and stale loud samples", (silenceFallback) => {
    const target = params({ silenceFallback });
    const orchestrator = new ParameterOrchestrator(target);
    const before = { ...advance(orchestrator, target) };
    const first = orchestrator.update(target, LOUD, false, 1 / 60);
    expectRate(before, first, 1 / 60);
    expect(first.bloom).toBeGreaterThan(0);
    const result = advance(orchestrator, target, LOUD, false, 900);
    expect(orchestrator.features.rms).toBeCloseTo(0, 6);
    expect(orchestrator.features.bass).toBeCloseTo(0, 6);
    expect(orchestrator.features.treble).toBeCloseTo(0, 6);
    expect(orchestrator.features.onset).toBeCloseTo(0, 6);
    expect(orchestrator.features.centroid).toBeCloseTo(0.5, 6);
    expect(result.temperature).toBeCloseTo(0, 6);
    expect(result.contrast).toBeCloseTo(target.baseContrast, 6);
    expect(result.grain).toBeCloseTo(target.grainBase, 6);
    expect(result.bloom).toBeCloseTo(0, 6);
    expect(result.bloomWarm).toBeCloseTo(0, 6);
  });

  it("releases every feature to neutral on silence fallback", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    advance(orchestrator);
    const result = advance(orchestrator, DEFAULT_PARAMS, { ...LOUD, silence: true }, true, 900);
    expect(orchestrator.features.centroid).toBeCloseTo(0.5, 6);
    for (const key of ["rms", "bass", "treble", "onset"] as const) expect(orchestrator.features[key]).toBeCloseTo(0, 6);
    expect(result.temperature).toBeCloseTo(0, 6);
  });

  it.each([0, 1])("gates silent temperature before slow centroid release (centroid=%s)", (centroid) => {
    const target = params({ centroidRelease: 2, rmsRelease: 0.05, silenceFallback: 0 });
    const orchestrator = new ParameterOrchestrator(target);
    advance(orchestrator, target, { ...LOUD, centroid }, true, 900);
    const result = advance(orchestrator, target, { ...LOUD, centroid, silence: true }, true, 120, 0.01);
    expect(Math.abs(orchestrator.features.centroid - 0.5)).toBeGreaterThan(0.1);
    expect(Math.abs(result.temperature)).toBeLessThan(1e-6);
    expect(orchestrator.features.rms).toBeGreaterThan(0.9);
    expect(centroid === 0 ? orchestrator.features.centroid < 0.5 : orchestrator.features.centroid > 0.5).toBe(true);
  });

  it("uses RMS energy for bass bloom and treble grain, not spectral proportions alone", () => {
    const target = params({ silenceFallback: 0 });
    const orchestrator = new ParameterOrchestrator(target);
    const result = advance(orchestrator, target, { ...LOUD, rms: 0, onset: 0 });
    expect(orchestrator.features.bass).toBeGreaterThan(0.9);
    expect(orchestrator.features.treble).toBeGreaterThan(0.9);
    expect(result.bloomWarm).toBe(0);
    expect(result.grain).toBe(target.grainBase);
    expect(result.temperature).toBe(0);
  });

  it.each([0.02, 0.2])("boosts visual response at RMS %s while preserving the measured value", (rms) => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const audio = { ...LOUD, rms, bass: 0.5, mid: 0.3, treble: 0.2, onset: 0, centroid: 0.5 };
    const result = advance(orchestrator, DEFAULT_PARAMS, audio);
    const energy = rmsToVisualLevel(rms) * DEFAULT_PARAMS.intensity;
    expect(orchestrator.features.rms).toBeCloseTo(rms, 8);
    expect(audio.rms).toBe(rms);
    expect(result.bloom).toBeCloseTo(energy * DEFAULT_PARAMS.mapRmsGlow, 6);
    expect(result.bloomWarm).toBeCloseTo(0.5 * energy * DEFAULT_PARAMS.mapBassWarm, 6);
    expect(result.grain).toBeCloseTo(DEFAULT_PARAMS.grainBase + 0.2 * energy * DEFAULT_PARAMS.mapTrebleGrain, 6);
    expect(result.contrast).toBe(DEFAULT_PARAMS.baseContrast);
    expectBounded(result);
  });

  it.each([0, 1])("keeps sub-threshold noise from driving effects with silenceFallback=%s", (silenceFallback) => {
    const target = params({ silenceFallback });
    const orchestrator = new ParameterOrchestrator(target);
    const result = advance(orchestrator, target, { ...LOUD, rms: 0.0009, onset: 0 });
    expect(result.bloom).toBe(0);
    expect(result.bloomWarm).toBe(0);
    expect(result.grain).toBe(target.grainBase);
    expect(rmsToVisualLevel(orchestrator.features.rms)).toBe(0);
  });

  it.each([true, false])("smoothly releases low-volume dynamics after silence (available=%s)", (available) => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const audio = { ...LOUD, rms: 0.02 };
    let previous = { ...advance(orchestrator, DEFAULT_PARAMS, audio) };
    expect(previous.bloom).toBeGreaterThan(0.2);
    for (let i = 0; i < 180; i++) {
      const result = orchestrator.update(DEFAULT_PARAMS, available ? SILENT : audio, available, 1 / 60);
      expectBounded(result);
      expectRate(previous, result, 1 / 60);
      expect(result.bloom).toBeLessThanOrEqual(previous.bloom);
      previous = { ...result };
    }
    expect(previous.bloom).toBe(0);
    expect(previous.bloomWarm).toBe(0);
    expect(previous.grain).toBe(DEFAULT_PARAMS.grainBase);
    expect(rmsToVisualLevel(orchestrator.features.rms)).toBe(0);
  });

  it("preserves the intensity and bloom switches at low volume", () => {
    const audio = { ...LOUD, rms: 0.02 };
    const disabled = params({ bloomEnabled: 0 });
    const withoutBloom = advance(new ParameterOrchestrator(disabled), disabled, audio);
    expect(withoutBloom.bloom).toBe(0);
    expect(withoutBloom.bloomWarm).toBe(0);
    const zero = params({ intensity: 0 });
    const withoutDynamics = advance(new ParameterOrchestrator(zero), zero, audio);
    expect(withoutDynamics.bloom).toBe(0);
    expect(withoutDynamics.bloomWarm).toBe(0);
    expect(withoutDynamics.grain).toBe(zero.grainBase);
  });

  it("keeps boosted low-to-high volume transitions within existing rate limits", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    let previous = { ...orchestrator.update(DEFAULT_PARAMS, SILENT, false, 0) };
    for (const rms of [0.02, 0.2, 0.01, 1, 0]) {
      for (let i = 0; i < 60; i++) {
        const result = orchestrator.update(DEFAULT_PARAMS, { ...LOUD, rms }, true, 1 / 60);
        expectBounded(result);
        expectRate(previous, result, 1 / 60);
        previous = { ...result };
      }
    }
  });

  it("bounds final compositions and per-second deltas across extreme retargets", () => {
    const upper: ParamValues = {};
    const lower: ParamValues = {};
    for (const def of PARAM_DEFS) {
      upper[def.key] = def.kind === "slider" ? def.max : 1;
      lower[def.key] = def.kind === "slider" ? def.min : 0;
    }
    Object.assign(upper, { lookDark: 0, lookCalm: 0, lookBright: 1 });
    const high = params(upper);
    const low = params(lower);
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    let previous = { ...orchestrator.update(DEFAULT_PARAMS, SILENT, false, 0) };
    for (const [target, audio] of [[high, LOUD], [low, { ...LOUD, centroid: 0 }], [high, LOUD]] as const) {
      for (let i = 0; i < 600; i++) {
        const current = orchestrator.update(target, audio, true, 1 / 60);
        expectBounded(current);
        expectRate(previous, current, 1 / 60);
        previous = { ...current };
      }
    }
    expect(previous.contrast).toBeCloseTo(2, 3);
    expect(previous.grain).toBeCloseTo(0.15, 3);
    expect(previous.bloom).toBeCloseTo(0.6, 3);
    expect(previous.bloomWarm).toBeCloseTo(0.35, 3);
  });

  it("retargets a style transition from its current blend rather than jumping", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const calm = parseParams(THEME_PRESETS[1].values, DEFAULT_PARAMS);
    const bright = parseParams(THEME_PRESETS[2].values, DEFAULT_PARAMS);
    const midway = { ...advance(orchestrator, calm, SILENT, false, 6) };
    expect(midway.lookCalm).toBeGreaterThan(0);
    expect(midway.lookCalm).toBeLessThan(1);
    const next = orchestrator.update(bright, SILENT, false, 1 / 60);
    expect(next.lookBright).toBeCloseTo(1 - Math.exp(-(1 / 60) / 0.2));
    expect(next.lookCalm).toBeCloseTo(midway.lookCalm * Math.exp(-(1 / 60) / 0.2));
    expectRate(midway, next, 1 / 60);
    expectBounded(next);
  });

  it("keeps a short onset perceptible despite the output contrast rate cap", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    let peak = orchestrator.update(DEFAULT_PARAMS, LOUD, true, 1 / 60).contrast;
    for (let i = 0; i < 30; i++) {
      peak = Math.max(peak, orchestrator.update(DEFAULT_PARAMS, { ...LOUD, onset: 0 }, true, 1 / 60).contrast);
    }
    expect(peak - DEFAULT_PARAMS.baseContrast).toBeGreaterThan(0.04);
    expect(peak).toBeLessThan(1.4);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("skips abnormal dt=%s without corrupting state", (dt) => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const previous = { ...advance(orchestrator) };
    const previousFeatures = { ...orchestrator.features };
    const previousParams = { ...orchestrator.params };
    const result = orchestrator.update(params({ brightness: 1.5 }), SILENT, false, dt);
    expect(result).toEqual(previous);
    expect(orchestrator.features).toEqual(previousFeatures);
    expect(orchestrator.params).toEqual(previousParams);
    expectBounded(result);
  });

  it("caps long frame gaps at 0.1 seconds", () => {
    const a = new ParameterOrchestrator(DEFAULT_PARAMS);
    const b = new ParameterOrchestrator(DEFAULT_PARAMS);
    expect(a.update(DEFAULT_PARAMS, LOUD, true, 10)).toEqual(b.update(DEFAULT_PARAMS, LOUD, true, 0.1));
    expect(a.features).toEqual(b.features);
  });

  it("defensively bounds malformed runtime samples and parameter targets", () => {
    const orchestrator = new ParameterOrchestrator(DEFAULT_PARAMS);
    const target = { ...DEFAULT_PARAMS, rmsAttack: 0, rmsRelease: -1, brightness: NaN, intensity: Infinity, grainBase: 100 };
    const audio = { ...LOUD, rms: NaN, bass: Infinity, treble: -10, onset: 20, centroid: NaN };
    const result = advance(orchestrator, target, audio);
    expectBounded(result);
    expect(orchestrator.params.rmsAttack).toBe(0.01);
    expect(orchestrator.params.rmsRelease).toBe(0.05);
    expect(Object.values(orchestrator.features).every(Number.isFinite)).toBe(true);
  });
});

import type { AudioFeatures } from "../audio/useAudioFeatures";
import { DEFAULT_PARAMS, PARAM_DEFS, parseParams, type ParamValues } from "./schema";

export type SmoothedFeatures = Record<"rms" | "bass" | "treble" | "onset" | "centroid", number>;

export interface RenderParameters {
  contrast: number;
  brightness: number;
  temperature: number;
  shadowCool: number;
  highlightThr: number;
  vignette: number;
  grain: number;
  bloom: number;
  bloomWarm: number;
  lookDark: number;
  lookCalm: number;
  lookBright: number;
}

const BASE_TAU = 0.2;
const RMS_SILENCE_THRESHOLD = 0.001;
const FEATURE_KEYS = ["rms", "bass", "treble", "onset", "centroid"] as const;
const LOOK_KEYS = ["lookDark", "lookCalm", "lookBright"] as const;
export const OUTPUT_LIMITS: Record<keyof RenderParameters, [number, number, number?]> = {
  contrast: [0.5, 2, 0.8],
  brightness: [0.5, 1.5, 0.4],
  temperature: [-1, 1, 0.8],
  shadowCool: [0, 1],
  highlightThr: [0.3, 0.9],
  vignette: [0, 1],
  grain: [0, 0.15, 0.15],
  bloom: [0, 0.6, 0.8],
  bloomWarm: [0, 0.35, 0.5],
  lookDark: [0, 1],
  lookCalm: [0, 1],
  lookBright: [0, 1],
};
const OUTPUT_KEYS = Object.keys(OUTPUT_LIMITS) as (keyof RenderParameters)[];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function frameDelta(dt: number): number {
  return Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
}

function featureValue(value: number, neutral: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : neutral;
}

export function rmsToVisualLevel(rms: number): number {
  // 对数映射让低音量可见，静音阈值以下仍为零，避免抬高底噪。
  const amplitude = Math.max(RMS_SILENCE_THRESHOLD, featureValue(rms, 0));
  return Math.log10(amplitude / RMS_SILENCE_THRESHOLD) / Math.log10(1 / RMS_SILENCE_THRESHOLD);
}

function normalizeLooks(params: ParamValues): void {
  const total = params.lookDark + params.lookCalm + params.lookBright;
  if (total > 1) {
    for (const key of LOOK_KEYS) params[key] /= total;
  }
}

export function smoothToward(current: number, target: number, dt: number, attack: number, release: number): number {
  const start = Number.isFinite(current) ? current : 0;
  const step = frameDelta(dt);
  if (step === 0 || !Number.isFinite(target)) return start;
  const time = target > start ? attack : release;
  const tau = Number.isFinite(time) && time > 0 ? time : BASE_TAU;
  return start + (target - start) * -Math.expm1(-step / tau);
}

export class ParameterOrchestrator {
  readonly features: SmoothedFeatures = { rms: 0, bass: 0, treble: 0, onset: 0, centroid: 0.5 };
  readonly params: ParamValues;
  private readonly targets: ParamValues;
  private readonly rendered: RenderParameters;
  private presence = 0;

  constructor(initial: ParamValues) {
    this.params = parseParams(initial, DEFAULT_PARAMS);
    normalizeLooks(this.params);
    this.targets = { ...this.params };
    this.rendered = this.compose();
    for (const key of OUTPUT_KEYS) {
      const [min, max] = OUTPUT_LIMITS[key];
      this.rendered[key] = clamp(this.rendered[key], min, max);
    }
  }

  update(target: ParamValues, features: AudioFeatures, available: boolean, dt: number): RenderParameters {
    const step = frameDelta(dt);
    if (step === 0) return this.rendered;

    for (const def of PARAM_DEFS) {
      const value = target[def.key];
      this.targets[def.key] = def.kind === "switch"
        ? (value === 0 || value === 1 ? value : this.params[def.key])
        : (Number.isFinite(value) ? clamp(value, def.min, def.max) : this.params[def.key]);
    }
    // 同一时间常数插值两个合法权重向量，过渡期间也不会超出总权重 1。
    normalizeLooks(this.targets);
    for (const def of PARAM_DEFS) {
      this.params[def.key] = def.kind === "switch" || def.unit === "s"
        ? this.targets[def.key]
        : smoothToward(this.params[def.key], this.targets[def.key], step, BASE_TAU, BASE_TAU);
    }

    const p = this.params;
    const silent = features.silence || featureValue(features.rms, 0) <= RMS_SILENCE_THRESHOLD;
    const fallback = !available || (silent && p.silenceFallback === 1);
    const present = available && !silent;
    for (const key of FEATURE_KEYS) {
      const neutral = key === "centroid" ? 0.5 : 0;
      const reset = key === "centroid" ? !present : fallback;
      const value = reset ? neutral : featureValue(features[key], neutral);
      const attack = reset ? p[`${key}Release`] : p[`${key}Attack`];
      this.features[key] = smoothToward(this.features[key], value, step, attack, p[`${key}Release`]);
    }
    // 频谱重心在静音时没有色温意义；独立释放门控，避免重心缓慢回落造成持续偏色。
    this.presence = smoothToward(this.presence, present ? 1 : 0, step, p.rmsAttack, p.rmsRelease);

    const composed = this.compose();
    for (const key of OUTPUT_KEYS) {
      const [min, max, rate] = OUTPUT_LIMITS[key];
      const desired = clamp(composed[key], min, max);
      const change = desired - this.rendered[key];
      this.rendered[key] = clamp(
        rate === undefined ? desired : this.rendered[key] + clamp(change, -rate * step, rate * step),
        min,
        max,
      );
    }
    return this.rendered;
  }

  private compose(): RenderParameters {
    const p = this.params;
    const f = this.features;
    const energy = rmsToVisualLevel(f.rms) * p.intensity;
    return {
      contrast: p.baseContrast + f.onset * p.mapOnsetContrast * p.intensity,
      brightness: p.brightness,
      temperature: (f.centroid - 0.5) * 2 * p.mapCentroidTemp * p.intensity * this.presence,
      shadowCool: p.shadowCool,
      highlightThr: p.highlightThr,
      vignette: p.vignette,
      grain: p.grainBase + f.treble * energy * p.mapTrebleGrain,
      bloom: p.bloomEnabled * energy * p.mapRmsGlow,
      bloomWarm: p.bloomEnabled * f.bass * energy * p.mapBassWarm,
      lookDark: p.lookDark,
      lookCalm: p.lookCalm,
      lookBright: p.lookBright,
    };
  }
}

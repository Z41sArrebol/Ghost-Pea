import type { MoodScores } from "../../packages/audio-ai/src";
import { OUTPUT_LIMITS, smoothToward, type RenderParameters } from "../params/orchestrator";
import type { ParamValues } from "../params/schema";

export type FilterMode = "default" | "ai";

const KEYS = Object.keys(OUTPUT_LIMITS) as (keyof RenderParameters)[];
const TRANSITION_SECONDS = 1.2;
const FAST_LIMITS = { contrast: 0.14, grain: 0.03, bloom: 0.18, bloomWarm: 0.1 } as const;
const FAST_KEYS = Object.keys(FAST_LIMITS) as (keyof typeof FAST_LIMITS)[];
// 节拍驱动的参数（鼓点对比度、响度柔光、高频颗粒、低频暖光）多保留一些快层动态，
// 情绪载体参数保持小比例，避免色温等被节拍抖动污染。
const BASE_BLEND: Record<keyof RenderParameters, number> = {
  contrast: 0,
  brightness: 0.15,
  temperature: 0.15,
  shadowCool: 0.15,
  highlightThr: 0.15,
  vignette: 0.15,
  grain: 0,
  bloom: 0,
  bloomWarm: 0,
  lookDark: 0.15,
  lookCalm: 0.15,
  lookBright: 0.15,
  lookHappy: 0.15,
  lookSad: 0.15,
  lookRelaxed: 0.15,
  lookAggressive: 0.15,
  saturation: 0.15,
  gammaMid: 0.15,
};
const AI_RATES: Record<keyof RenderParameters, number> = {
  contrast: 0.12,
  brightness: 0.05,
  temperature: 0.16,
  shadowCool: 0.1,
  highlightThr: 0.05,
  vignette: 0.1,
  grain: 0.012,
  bloom: 0.08,
  bloomWarm: 0.04,
  lookDark: 0.18,
  lookCalm: 0.18,
  lookBright: 0.18,
  lookHappy: 0.18,
  lookSad: 0.18,
  lookRelaxed: 0.18,
  lookAggressive: 0.18,
  saturation: 0.12,
  gammaMid: 0.06,
};

function composeAiTarget(base: RenderParameters, params: ParamValues, mood: MoodScores | null): RenderParameters {
  const target: RenderParameters = {
    contrast: params.baseContrast,
    brightness: params.brightness,
    temperature: 0,
    shadowCool: params.shadowCool,
    highlightThr: params.highlightThr,
    vignette: params.vignette,
    grain: params.grainBase,
    bloom: 0,
    bloomWarm: 0,
    lookDark: params.lookDark,
    lookCalm: params.lookCalm,
    lookBright: params.lookBright,
    lookHappy: 0,
    lookSad: 0,
    lookRelaxed: 0,
    lookAggressive: 0,
    saturation: 1,
    gammaMid: 1,
  };
  if (!mood || [mood.happy, mood.sad, mood.relaxed, mood.aggressive].every((score) => score === 0)) return target;

  for (const key of KEYS) target[key] += (base[key] - target[key]) * BASE_BLEND[key];
  const happy = Math.max(0, (mood.happy - 0.5) * 2);
  const sad = Math.max(0, (mood.sad - 0.5) * 2);
  const relaxed = Math.max(0, (mood.relaxed - 0.5) * 2);
  const aggressive = Math.max(0, (mood.aggressive - 0.5) * 2);
  const amount = params.intensity;

  target.contrast += amount * (0.06 * happy + 0.22 * aggressive - 0.06 * sad - 0.18 * relaxed);
  target.brightness += amount * (0.12 * happy - 0.12 * sad + 0.05 * relaxed - 0.03 * aggressive);
  // The shader uses negative temperature for warm tones, positive for cool tones.
  target.temperature += amount * (-0.32 * happy + 0.32 * sad + 0.16 * aggressive - 0.06 * relaxed);
  target.shadowCool += amount * (0.18 * sad + 0.15 * aggressive - 0.2 * happy - 0.08 * relaxed);
  target.vignette += amount * (0.06 * sad + 0.08 * aggressive - 0.25 * happy - 0.2 * relaxed);
  target.grain += amount * (0.012 * sad + 0.035 * aggressive - 0.012 * relaxed - 0.008 * happy);
  target.highlightThr -= amount * (0.05 * happy + 0.1 * relaxed);
  target.bloom += params.bloomEnabled * amount * (0.1 * happy + 0.2 * relaxed + 0.02 * aggressive);
  target.bloomWarm += params.bloomEnabled * amount * (0.1 * happy + 0.05 * relaxed);
  target.saturation += amount * (0.25 * happy + 0.15 * aggressive - 0.3 * sad - 0.1 * relaxed);
  target.gammaMid += amount * (0.15 * happy + 0.1 * relaxed - 0.1 * sad - 0.05 * aggressive);

  // 每种情绪驱动自己的专属 LUT，用户的主题风格按剩余权重保留；总权重恒 ≤1。
  const budget = 0.6 * amount / Math.max(1, happy + sad + relaxed + aggressive);
  const retained = 1 - (happy + sad + relaxed + aggressive) * budget;
  target.lookDark *= retained;
  target.lookCalm *= retained;
  target.lookBright *= retained;
  target.lookHappy = happy * budget;
  target.lookSad = sad * budget;
  target.lookRelaxed = relaxed * budget;
  target.lookAggressive = aggressive * budget;
  return target;
}

export class AiFilterController {
  private rendered: RenderParameters | null = null;
  private lastOutput: RenderParameters | null = null;
  private readonly fast = { contrast: 0, grain: 0, bloom: 0, bloomWarm: 0 };
  private previousMode: FilterMode = "default";
  private returnFrom: RenderParameters | null = null;
  private returnProgress = 0;

  update(
    base: RenderParameters,
    params: ParamValues,
    mode: FilterMode,
    mood: MoodScores | null,
    dt: number,
  ): RenderParameters {
    const wasInitialized = this.rendered !== null;
    if (!this.rendered) {
      this.rendered = { ...base };
      if (mode === "ai") {
        this.rendered.contrast = params.baseContrast;
        this.rendered.grain = params.grainBase;
        this.rendered.bloom = 0;
        this.rendered.bloomWarm = 0;
      }
    }
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    if (mode === "default") {
      if (this.previousMode === "ai") {
        this.returnFrom = { ...(this.lastOutput ?? this.rendered) };
        this.returnProgress = 0;
      }
      for (const key of FAST_KEYS) this.fast[key] = 0;
      this.lastOutput = null;
      this.previousMode = mode;
      if (this.returnFrom) {
        this.returnProgress = Math.min(1, this.returnProgress + step / TRANSITION_SECONDS);
        const blend = this.returnProgress ** 2 * (3 - 2 * this.returnProgress);
        for (const key of KEYS) {
          this.rendered[key] = this.returnFrom[key] + (base[key] - this.returnFrom[key]) * blend;
        }
        if (this.returnProgress === 1) this.returnFrom = null;
      } else {
        Object.assign(this.rendered, base);
      }
      return this.rendered;
    }

    if (wasInitialized && this.previousMode === "default") {
      for (const key of FAST_KEYS) {
        const neutral = key === "contrast" ? params.baseContrast
          : key === "grain" ? params.grainBase : 0;
        const limit = FAST_LIMITS[key];
        this.fast[key] = limit * Math.tanh((base[key] - neutral) / limit);
        this.rendered[key] = Math.max(OUTPUT_LIMITS[key][0], this.rendered[key] - this.fast[key]);
      }
    }
    this.previousMode = mode;
    this.returnFrom = null;
    const target = composeAiTarget(base, params, mood);
    const desired = { ...this.rendered };
    for (const key of KEYS) {
      const [min, max] = OUTPUT_LIMITS[key];
      const bounded = Math.max(min, Math.min(max, target[key]));
      const next = smoothToward(this.rendered[key], bounded, step, TRANSITION_SECONDS, TRANSITION_SECONDS);
      const change = AI_RATES[key] * step;
      desired[key] = this.rendered[key] + Math.max(-change, Math.min(change, next - this.rendered[key]));
    }
    // A shared interpolation factor keeps the LUT weights inside their combined budget.
    const lookKeys = ["lookDark", "lookCalm", "lookBright", "lookHappy", "lookSad", "lookRelaxed", "lookAggressive"] as const;
    let lookBlend = 1;
    for (const key of lookKeys) {
      const distance = Math.abs(target[key] - this.rendered[key]);
      if (distance > 0) lookBlend = Math.min(lookBlend, AI_RATES[key] * step / distance);
    }
    lookBlend = Math.min(lookBlend, 1 - Math.exp(-step / TRANSITION_SECONDS));
    for (const key of lookKeys) desired[key] = this.rendered[key] + (target[key] - this.rendered[key]) * lookBlend;
    if (!params.bloomEnabled) {
      desired.bloom = 0;
      desired.bloomWarm = 0;
    }
    Object.assign(this.rendered, desired);
    const output = { ...this.rendered };
    for (const key of FAST_KEYS) {
      const neutral = key === "contrast" ? params.baseContrast
        : key === "grain" ? params.grainBase : 0;
      const delta = base[key] - neutral;
      const limit = FAST_LIMITS[key];
      const bounded = limit * Math.tanh(delta / limit);
      this.fast[key] = smoothToward(this.fast[key], bounded, step, 0.03, 0.16);
      const [min, max] = OUTPUT_LIMITS[key];
      output[key] = Math.max(min, Math.min(max, output[key] + this.fast[key]));
    }
    if (!params.bloomEnabled) {
      output.bloom = 0;
      output.bloomWarm = 0;
    }
    this.lastOutput = output;
    return output;
  }
}

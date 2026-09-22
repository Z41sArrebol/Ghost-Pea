import type { MoodScores } from "../../packages/audio-ai/src";
import { OUTPUT_LIMITS, smoothToward, type RenderParameters } from "../params/orchestrator";
import type { ParamValues } from "../params/schema";

export type FilterMode = "default" | "ai";

const KEYS = Object.keys(OUTPUT_LIMITS) as (keyof RenderParameters)[];
const TRANSITION_SECONDS = 1.2;
const AI_RATES: Record<keyof RenderParameters, number> = {
  contrast: 0.3,
  brightness: 0.14,
  temperature: 0.45,
  shadowCool: 0.25,
  highlightThr: 0.1,
  vignette: 0.35,
  grain: 0.045,
  bloom: 0.2,
  bloomWarm: 0.12,
  lookDark: 0.3,
  lookCalm: 0.3,
  lookBright: 0.3,
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
  };
  if (!mood || [mood.happy, mood.sad, mood.relaxed, mood.aggressive].every((score) => score === 0)) return target;

  for (const key of KEYS) target[key] += (base[key] - target[key]) * 0.15;
  const happy = Math.max(0, (mood.happy - 0.5) * 2);
  const sad = Math.max(0, (mood.sad - 0.5) * 2);
  const relaxed = Math.max(0, (mood.relaxed - 0.5) * 2);
  const aggressive = Math.max(0, (mood.aggressive - 0.5) * 2);
  const amount = params.intensity;

  target.contrast += amount * (0.18 * happy + 0.75 * aggressive - 0.15 * sad - 0.5 * relaxed);
  target.brightness += amount * (0.38 * happy - 0.35 * sad + 0.12 * relaxed - 0.08 * aggressive);
  // The shader uses negative temperature for warm tones, positive for cool tones.
  target.temperature += amount * (-0.9 * happy + 0.9 * sad + 0.45 * aggressive - 0.18 * relaxed);
  target.shadowCool += amount * (0.45 * sad + 0.4 * aggressive - 0.5 * happy - 0.2 * relaxed);
  target.vignette += amount * (0.1 * sad + 0.15 * aggressive - 0.9 * happy - 0.75 * relaxed);
  target.grain += amount * (0.035 * sad + 0.12 * aggressive - 0.04 * relaxed - 0.025 * happy);
  target.highlightThr -= amount * (0.1 * happy + 0.2 * relaxed);
  target.bloom += params.bloomEnabled * amount * (0.18 * happy + 0.42 * relaxed + 0.035 * aggressive);
  target.bloomWarm += params.bloomEnabled * amount * (0.2 * happy + 0.1 * relaxed);

  // Cap the visual mixing budget, rather than treating independent scores as probabilities.
  const budget = 0.95 * amount / Math.max(1, happy + sad + relaxed + aggressive);
  const dark = (sad + aggressive * 0.8) * budget;
  const calm = relaxed * budget;
  const bright = happy * budget;
  const retained = 1 - dark - calm - bright;
  target.lookDark = target.lookDark * retained + dark;
  target.lookCalm = target.lookCalm * retained + calm;
  target.lookBright = target.lookBright * retained + bright;
  return target;
}

export class AiFilterController {
  private rendered: RenderParameters | null = null;
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
    this.rendered ??= { ...base };
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    if (mode === "default") {
      if (this.previousMode === "ai") {
        this.returnFrom = { ...this.rendered };
        this.returnProgress = 0;
      }
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
    // A shared interpolation factor keeps the three LUT weights inside their combined budget.
    const lookKeys = ["lookDark", "lookCalm", "lookBright"] as const;
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
    return this.rendered;
  }
}

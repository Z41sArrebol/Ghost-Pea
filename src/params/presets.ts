import type { ParamValues } from "./schema";

// P1 三主题的参数包雏形。预设只覆盖 filter + mapping 两组，
// 编排器（平滑手感）和相机配置不受主题切换影响。
export interface ThemePreset {
  key: string;
  label: string;
  values: Partial<ParamValues>;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    key: "dark",
    label: "Dark / Tension",
    values: {
      baseContrast: 1.12,
      brightness: 0.95,
      vignette: 1,
      grainBase: 0.03,
      highlightThr: 0.55,
      shadowCool: 0.35,
      mapRmsGlow: 0.7,
      mapBassWarm: 1,
      mapTrebleGrain: 0.12,
      mapOnsetContrast: 0.35,
      mapCentroidTemp: 1,
    },
  },
  {
    key: "calm",
    label: "Calm / Dream",
    values: {
      baseContrast: 1.0,
      brightness: 1.0,
      vignette: 0.5,
      grainBase: 0.02,
      highlightThr: 0.6,
      shadowCool: 0.15,
      mapRmsGlow: 0.9,
      mapBassWarm: 0.8,
      mapTrebleGrain: 0.08,
      mapOnsetContrast: 0.2,
      mapCentroidTemp: 0.8,
    },
  },
  {
    key: "bright",
    label: "Bright / Alive",
    values: {
      baseContrast: 1.05,
      brightness: 1.1,
      vignette: 0.3,
      grainBase: 0.015,
      highlightThr: 0.6,
      shadowCool: 0.05,
      mapRmsGlow: 0.5,
      mapBassWarm: 1.2,
      mapTrebleGrain: 0.05,
      mapOnsetContrast: 0.25,
      mapCentroidTemp: 0.6,
    },
  },
];

// 参数 schema：面板的唯一真源。加参数 = 在这里加一条定义 + DEFAULT_PARAMS 加默认值，
// 面板和 shader uniform 传参都从这里派生，UI 不需要改。

export type ParamGroup = "filter" | "mapping" | "orchestrator";

export type ParamValues = Record<string, number>;

interface SliderDef {
  kind: "slider";
  key: string;
  label: string;
  group: ParamGroup;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

interface SwitchDef {
  kind: "switch";
  key: string;
  label: string;
  group: ParamGroup;
}

export type ParamDef = SliderDef | SwitchDef;

export const PARAM_DEFS: ParamDef[] = [
  // ---- 滤镜基础（shader 静态参数）----
  { kind: "slider", key: "baseContrast", label: "基础对比度", group: "filter", min: 0.5, max: 2, step: 0.01 },
  { kind: "slider", key: "brightness", label: "整体亮度", group: "filter", min: 0.5, max: 1.5, step: 0.01 },
  { kind: "slider", key: "vignette", label: "暗角强度", group: "filter", min: 0, max: 1, step: 0.01 },
  { kind: "slider", key: "grainBase", label: "颗粒基础量", group: "filter", min: 0, max: 0.2, step: 0.005 },
  { kind: "slider", key: "highlightThr", label: "高光阈值", group: "filter", min: 0.3, max: 0.9, step: 0.01 },
  { kind: "slider", key: "shadowCool", label: "阴影冷化", group: "filter", min: 0, max: 1, step: 0.01 },

  // ---- 音频映射系数（特征对画面的影响力，0 = 关闭该路映射）----
  { kind: "slider", key: "mapRmsGlow", label: "RMS → 光晕", group: "mapping", min: 0, max: 2, step: 0.01 },
  { kind: "slider", key: "mapBassWarm", label: "Bass → 暖色扩散", group: "mapping", min: 0, max: 2, step: 0.01 },
  { kind: "slider", key: "mapTrebleGrain", label: "Treble → 颗粒活跃", group: "mapping", min: 0, max: 0.3, step: 0.005 },
  { kind: "slider", key: "mapOnsetContrast", label: "Onset → 瞬时对比", group: "mapping", min: 0, max: 1, step: 0.01 },
  { kind: "slider", key: "mapCentroidTemp", label: "Centroid → 色温", group: "mapping", min: 0, max: 2, step: 0.01 },

  // ---- 编排器（平滑时间常数 + 全局强度 + 静音回落）----
  { kind: "slider", key: "rmsAttack", label: "RMS Attack", group: "orchestrator", min: 0.01, max: 1, step: 0.01, unit: "s" },
  { kind: "slider", key: "rmsRelease", label: "RMS Release", group: "orchestrator", min: 0.05, max: 2, step: 0.01, unit: "s" },
  { kind: "slider", key: "bassAttack", label: "Bass Attack", group: "orchestrator", min: 0.01, max: 1, step: 0.01, unit: "s" },
  { kind: "slider", key: "bassRelease", label: "Bass Release", group: "orchestrator", min: 0.05, max: 2, step: 0.01, unit: "s" },
  { kind: "slider", key: "trebleAttack", label: "Treble Attack", group: "orchestrator", min: 0.01, max: 1, step: 0.01, unit: "s" },
  { kind: "slider", key: "trebleRelease", label: "Treble Release", group: "orchestrator", min: 0.05, max: 2, step: 0.01, unit: "s" },
  { kind: "slider", key: "onsetAttack", label: "Onset Attack", group: "orchestrator", min: 0.01, max: 1, step: 0.01, unit: "s" },
  { kind: "slider", key: "onsetRelease", label: "Onset Release", group: "orchestrator", min: 0.05, max: 2, step: 0.01, unit: "s" },
  { kind: "slider", key: "centroidAttack", label: "Centroid Attack", group: "orchestrator", min: 0.01, max: 1, step: 0.01, unit: "s" },
  { kind: "slider", key: "centroidRelease", label: "Centroid Release", group: "orchestrator", min: 0.05, max: 2, step: 0.01, unit: "s" },
  { kind: "slider", key: "intensity", label: "全局动态强度", group: "orchestrator", min: 0, max: 1, step: 0.01 },
  { kind: "switch", key: "silenceFallback", label: "静音回落", group: "orchestrator" },
];

// 默认值 = 当前 Dark/Tension 演示效果的手感
export const DEFAULT_PARAMS: ParamValues = {
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
  rmsAttack: 0.05,
  rmsRelease: 0.35,
  bassAttack: 0.08,
  bassRelease: 0.4,
  trebleAttack: 0.05,
  trebleRelease: 0.3,
  onsetAttack: 0.01,
  onsetRelease: 0.15,
  centroidAttack: 0.2,
  centroidRelease: 0.8,
  intensity: 0.8,
  silenceFallback: 1,
};

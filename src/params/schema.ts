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
  hidden?: boolean;
}

interface SwitchDef {
  kind: "switch";
  key: string;
  label: string;
  group: ParamGroup;
}

export type ParamDef = SliderDef | SwitchDef;

export const PARAM_DEFS: ParamDef[] = [
  { kind: "slider", key: "baseContrast", label: "基础对比度", group: "filter", min: 0.5, max: 2, step: 0.01 },
  { kind: "slider", key: "brightness", label: "整体亮度", group: "filter", min: 0.5, max: 1.5, step: 0.01 },
  { kind: "slider", key: "vignette", label: "暗角强度", group: "filter", min: 0, max: 1, step: 0.01 },
  { kind: "slider", key: "grainBase", label: "颗粒基础量", group: "filter", min: 0, max: 0.15, step: 0.005 },
  { kind: "slider", key: "highlightThr", label: "高光阈值", group: "filter", min: 0.3, max: 0.9, step: 0.01 },
  { kind: "slider", key: "shadowCool", label: "阴影冷化", group: "filter", min: 0, max: 1, step: 0.01 },
  { kind: "switch", key: "bloomEnabled", label: "高光扩散", group: "filter" },
  { kind: "slider", key: "lookDark", label: "Dark 风格权重", group: "filter", min: 0, max: 1, step: 0.01, hidden: true },
  { kind: "slider", key: "lookCalm", label: "Calm 风格权重", group: "filter", min: 0, max: 1, step: 0.01, hidden: true },
  { kind: "slider", key: "lookBright", label: "Bright 风格权重", group: "filter", min: 0, max: 1, step: 0.01, hidden: true },

  { kind: "slider", key: "mapRmsGlow", label: "RMS → 光晕", group: "mapping", min: 0, max: 2, step: 0.01 },
  { kind: "slider", key: "mapBassWarm", label: "Bass → 暖色扩散", group: "mapping", min: 0, max: 2, step: 0.01 },
  { kind: "slider", key: "mapTrebleGrain", label: "Treble → 颗粒活跃", group: "mapping", min: 0, max: 0.3, step: 0.005 },
  { kind: "slider", key: "mapOnsetContrast", label: "Onset → 瞬时对比", group: "mapping", min: 0, max: 1, step: 0.01 },
  { kind: "slider", key: "mapCentroidTemp", label: "Centroid → 色温", group: "mapping", min: 0, max: 2, step: 0.01 },

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

export const DEFAULT_PARAMS: ParamValues = {
  baseContrast: 1.12,
  brightness: 0.95,
  vignette: 1,
  grainBase: 0.03,
  highlightThr: 0.55,
  shadowCool: 0.35,
  bloomEnabled: 1,
  lookDark: 1,
  lookCalm: 0,
  lookBright: 0,
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

export function parseParams(input: unknown, current: ParamValues): ParamValues {
  if (
    typeof input !== "object" || input === null ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    throw new Error("参数必须是 JSON 对象，不能是数组、null 或其他类型；未修改任何参数。");
  }

  const next = { ...current };
  for (const def of PARAM_DEFS) {
    const property = Object.getOwnPropertyDescriptor(input, def.key);
    if (!property) continue;
    const value: unknown = property.value;
    const expected = def.kind === "switch" ? "数字 0 或 1" : `${def.min} 到 ${def.max} 之间的有限数字`;
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      (def.kind === "switch" ? value !== 0 && value !== 1 : value < def.min || value > def.max)
    ) {
      throw new Error(`参数「${def.label}」(${def.key}) 必须是${expected}，不接受字符串或布尔值；未修改任何参数。`);
    }
    next[def.key] = value;
  }

  // 剩余权重留给原始色彩；仅容忍浮点加法误差，不静默重分配用户权重。
  if (next.lookDark + next.lookCalm + next.lookBright > 1 + 1e-9) {
    throw new Error("lookDark、lookCalm、lookBright 合计不能超过 1；请同时调低其他风格权重后重试，未修改任何参数。");
  }
  return next;
}

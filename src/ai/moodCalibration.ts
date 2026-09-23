const HAPPY_CENTER = 0.2;
const SAD_CENTER = 0.7;
const SAD_WEIGHT = 0.15;
const RELAXED_CENTER = 0.5;
const AGGRESSIVE_CENTER = 0.3;
const AROUSAL_GAIN = 2.5;
// 默认灵敏度保持在 sigmoid 的线性区，歌曲内部的情绪波动能连续反映到滤镜，而不是被钉在 0/1 两端。
export const DEFAULT_VALENCE_SENSITIVITY = 8;

export interface HappySadCalibration {
  happy: number;
  sad: number;
  valence: number;
}

export interface RelaxedAggressiveCalibration {
  relaxed: number;
  aggressive: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function calibrateHappySad(happy: number, sad: number, sensitivity: number): HappySadCalibration {
  if (![happy, sad, sensitivity].every(Number.isFinite)) {
    throw new Error("Mood calibration requires finite values");
  }

  const evidence = happy - HAPPY_CENTER - SAD_WEIGHT * (sad - SAD_CENTER);
  const valence = clamp01(1 / (1 + Math.exp(-sensitivity * evidence)));
  return { happy: valence, sad: 1 - valence, valence };
}

// relaxed/aggressive 原始分常落在滤镜 0.5 证据门槛之外，按中心值线性放大；原始 0 仍映射为 0。
// 中心值来自真机观测分布（relaxed 常见 0.5~0.65），音乐库变化大时需要重新标定。
export function calibrateRelaxedAggressive(relaxed: number, aggressive: number): RelaxedAggressiveCalibration {
  if (![relaxed, aggressive].every(Number.isFinite)) {
    throw new Error("Mood calibration requires finite values");
  }
  return {
    relaxed: clamp01(0.5 + (relaxed - RELAXED_CENTER) * AROUSAL_GAIN),
    aggressive: clamp01(0.5 + (aggressive - AGGRESSIVE_CENTER) * AROUSAL_GAIN),
  };
}
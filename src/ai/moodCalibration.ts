const HAPPY_CENTER = 0.2;
const SAD_CENTER = 0.7;
const SAD_WEIGHT = 0.15;

export interface HappySadCalibration {
  happy: number;
  sad: number;
  valence: number;
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
import type { MoodScores } from "./contracts";

export type MoodKey = keyof MoodScores;

export interface MoodModelDefinition {
  key: MoodKey;
  directory: string;
  positiveClassIndex: 0 | 1;
}

export const MOOD_MODELS: readonly MoodModelDefinition[] = [
  { key: "happy", directory: "mood_happy-musicnn-msd-2", positiveClassIndex: 0 },
  { key: "sad", directory: "mood_sad-musicnn-msd-2", positiveClassIndex: 1 },
  { key: "relaxed", directory: "mood_relaxed-musicnn-msd-2", positiveClassIndex: 1 },
  { key: "aggressive", directory: "mood_aggressive-musicnn-msd-2", positiveClassIndex: 0 },
];

export function readPositiveScore(prediction: unknown, positiveClassIndex: 0 | 1): number {
  if (!Array.isArray(prediction) || prediction.length === 0) {
    throw new Error("Mood model returned no predictions");
  }

  let sum = 0;
  for (const batch of prediction) {
    if (!Array.isArray(batch) || batch.length <= positiveClassIndex) {
      throw new Error("Mood model returned an invalid output shape");
    }
    const score = Number(batch[positiveClassIndex]);
    if (!Number.isFinite(score)) throw new Error("Mood model returned a non-finite score");
    sum += score;
  }
  return sum / prediction.length;
}
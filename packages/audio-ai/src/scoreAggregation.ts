import type { MoodScores } from "./contracts";

const MOOD_KEYS = ["happy", "sad", "relaxed", "aggressive"] as const;
const ZERO_SCORES: MoodScores = { happy: 0, sad: 0, relaxed: 0, aggressive: 0 };

export class RollingMoodScores {
  private readonly history: MoodScores[] = [];
  private epoch: bigint | null = null;

  constructor(private readonly maxWindows = 8) {
    if (!Number.isInteger(maxWindows) || maxWindows < 1) {
      throw new Error("Mood score window count must be a positive integer");
    }
  }

  push(epoch: bigint, scores: MoodScores): MoodScores {
    if (this.epoch !== epoch) {
      this.reset();
      this.epoch = epoch;
    }

    if (MOOD_KEYS.every((key) => scores[key] === 0)) {
      this.reset();
      this.epoch = epoch;
      return { ...ZERO_SCORES };
    }

    this.history.push(scores);
    if (this.history.length > this.maxWindows) this.history.shift();

    const averaged = { ...ZERO_SCORES };
    for (const sample of this.history) {
      for (const key of MOOD_KEYS) averaged[key] += sample[key] / this.history.length;
    }
    return averaged;
  }

  reset(): void {
    this.history.length = 0;
    this.epoch = null;
  }
}

export function getDominanceConfidence(scores: MoodScores): number {
  const [highest = 0, secondHighest = 0] = MOOD_KEYS.map((key) => scores[key]).sort((a, b) => b - a);
  if (highest <= 0) return 0;
  return Math.max(0, Math.min(1, (highest - secondHighest) / highest));
}
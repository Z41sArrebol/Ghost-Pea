import { describe, expect, it } from "vitest";
import { getDominanceConfidence, RollingMoodScores } from "../src/scoreAggregation";

describe("RollingMoodScores", () => {
  it("averages recent windows and drops the oldest", () => {
    const rolling = new RollingMoodScores(2);
    rolling.push(1n, { happy: 0.2, sad: 0.8, relaxed: 0.1, aggressive: 0.3 });
    expect(rolling.push(1n, { happy: 0.8, sad: 0.2, relaxed: 0.3, aggressive: 0.1 })).toEqual({
      happy: 0.5,
      sad: 0.5,
      relaxed: 0.2,
      aggressive: 0.2,
    });
    expect(rolling.push(1n, { happy: 0.6, sad: 0.4, relaxed: 0.5, aggressive: 0.3 })).toEqual({
      happy: 0.7,
      sad: 0.30000000000000004,
      relaxed: 0.4,
      aggressive: 0.2,
    });
  });

  it("resets across epochs and on silence", () => {
    const rolling = new RollingMoodScores();
    rolling.push(1n, { happy: 0.9, sad: 0.1, relaxed: 0.2, aggressive: 0.3 });
    expect(rolling.push(2n, { happy: 0.1, sad: 0.7, relaxed: 0.2, aggressive: 0.3 }).sad).toBe(0.7);
    expect(rolling.push(2n, { happy: 0, sad: 0, relaxed: 0, aggressive: 0 })).toEqual({
      happy: 0,
      sad: 0,
      relaxed: 0,
      aggressive: 0,
    });
  });
});

describe("getDominanceConfidence", () => {
  it("measures separation from the runner-up instead of absolute activation", () => {
    expect(getDominanceConfidence({ happy: 0.6, sad: 0.3, relaxed: 0.2, aggressive: 0.1 })).toBeCloseTo(0.5);
    expect(getDominanceConfidence({ happy: 0.6, sad: 0.55, relaxed: 0.2, aggressive: 0.1 })).toBeCloseTo(1 / 12);
    expect(getDominanceConfidence({ happy: 0, sad: 0, relaxed: 0, aggressive: 0 })).toBe(0);
  });
});
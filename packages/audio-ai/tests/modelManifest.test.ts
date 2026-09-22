import { describe, expect, it } from "vitest";
import { MOOD_MODELS, readPositiveScore } from "../src/modelManifest";

describe("mood model manifest", () => {
  it("uses the positive class order published by the Essentia.js mood demo", () => {
    expect(MOOD_MODELS.map(({ key, positiveClassIndex }) => [key, positiveClassIndex])).toEqual([
      ["happy", 0],
      ["sad", 1],
      ["relaxed", 1],
      ["aggressive", 0],
    ]);
  });

  it("averages the positive class across model batches", () => {
    expect(readPositiveScore([[0.8, 0.2], [0.6, 0.4]], 0)).toBeCloseTo(0.7);
    expect(readPositiveScore([[0.8, 0.2], [0.6, 0.4]], 1)).toBeCloseTo(0.3);
  });

  it("rejects malformed model output", () => {
    expect(() => readPositiveScore([], 0)).toThrow("no predictions");
    expect(() => readPositiveScore([[Number.NaN, 0]], 0)).toThrow("non-finite");
  });
});
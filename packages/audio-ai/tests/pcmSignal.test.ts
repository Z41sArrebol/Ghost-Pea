import { describe, expect, it } from "vitest";
import { isSilentPcm } from "../src/pcmSignal";

describe("isSilentPcm", () => {
  it("recognizes zero and low-energy windows as silence", () => {
    expect(isSilentPcm(new Float32Array(48_000))).toBe(true);
    expect(isSilentPcm(new Float32Array(48_000).fill(0.0005))).toBe(true);
  });

  it("keeps audible windows for model inference", () => {
    expect(isSilentPcm(new Float32Array(48_000).fill(0.01))).toBe(false);
  });

  it("rejects non-finite samples", () => {
    expect(() => isSilentPcm(Float32Array.of(0, Number.NaN))).toThrow("non-finite sample");
  });
});
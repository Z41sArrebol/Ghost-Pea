import { describe, expect, it } from "vitest";
import { createLut, gradeColor, LUT_SIZE, type Color, type Look } from "./luts";

describe("built-in LUTs", () => {
  it("keeps identity colors and packs red as the fastest-changing coordinate", () => {
    const data = createLut("neutral");
    expect(data.length).toBe(LUT_SIZE ** 3 * 4);
    for (const [r, g, b] of [[0, 0, 0], [31, 0, 0], [0, 31, 0], [0, 0, 31], [15, 12, 24], [31, 31, 31]]) {
      const offset = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4;
      expect([...data.slice(offset, offset + 4)]).toEqual([r, g, b].map((value) => Math.round(value / 31 * 255)).concat(255));
    }
    expect(gradeColor([0.2, 0.5, 0.7], "neutral")).toEqual([0.2, 0.5, 0.7]);
  });

  it.each<Look>(["dark", "calm", "bright", "happy", "sad", "relaxed", "aggressive", "beat"])("creates finite bounded colors for %s", (look) => {
    for (let r = 0; r <= 10; r++) for (let g = 0; g <= 10; g++) for (let b = 0; b <= 10; b++) {
      for (const value of gradeColor([r / 10, g / 10, b / 10], look)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives the three themes distinct original color responses", () => {
    const colors = (["dark", "calm", "bright"] as Look[]).map((look) => gradeColor([0.2, 0.3, 0.4], look).join(","));
    expect(new Set(colors).size).toBe(3);
  });

  it("changes beat highlights gently while leaving black unchanged", () => {
    expect(gradeColor([0, 0, 0], "beat")).toEqual([0, 0, 0]);
    const bright = gradeColor([0.8, 0.8, 0.8], "beat");
    expect(bright[0]).toBeGreaterThan(0.8);
    expect(bright[2]).toBeLessThan(0.8);
  });

  it("gives the four moods clearly separated color identities across the tonal range", () => {
    const moods = ["happy", "sad", "relaxed", "aggressive"] as Look[];
    for (const tone of [[0.1, 0.12, 0.15], [0.45, 0.5, 0.55], [0.85, 0.88, 0.9]] as Color[]) {
      const colors = moods.map((look) => gradeColor(tone, look).join(","));
      expect(new Set(colors).size).toBe(4);
    }
    // happy 偏暖（红强蓝弱），sad 偏冷（蓝强红弱），aggressive 阴影偏青（蓝绿高于红）。
    const [happy, sad, , aggressive] = moods.map((look) => gradeColor([0.4, 0.42, 0.45], look));
    expect(happy[0]).toBeGreaterThan(happy[2]);
    expect(sad[2]).toBeGreaterThan(sad[0]);
    expect(aggressive[2]).toBeGreaterThan(aggressive[0]);
    // relaxed 抬黑明显：纯黑映射到粉彩雾面而不是纯黑。
    const relaxedBlack = gradeColor([0, 0, 0], "relaxed");
    expect(Math.min(...relaxedBlack)).toBeGreaterThan(0.1);
  });
});

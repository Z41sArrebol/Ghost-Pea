export type Look = "neutral" | "dark" | "calm" | "bright" | "happy" | "sad" | "relaxed" | "aggressive";
export type Color = [number, number, number];
export const LUT_SIZE = 32;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function gradeColor(color: Color, look: Look): Color {
  if (look === "neutral") return [...color];
  const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  const shadow = (1 - luminance) ** 2;
  const highlight = luminance ** 2;
  const saturation = look === "calm" ? 0.84 : look === "bright" ? 1.12
    : look === "happy" ? 1.15 : look === "sad" ? 0.6
    : look === "relaxed" ? 0.9 : look === "aggressive" ? 0.8 : 0.92;
  const c = color.map((channel) => luminance + (channel - luminance) * saturation);
  if (look === "dark") {
    return [
      clamp(c[0] - 0.025 * shadow + 0.025 * highlight),
      clamp(c[1] + 0.012 * shadow),
      clamp(c[2] + 0.045 * shadow - 0.02 * highlight),
    ];
  }
  if (look === "calm") {
    return [clamp(c[0] * 0.94 + 0.045), clamp(c[1] * 0.94 + 0.032), clamp(c[2] * 0.92 + 0.028)];
  }
  if (look === "bright") {
    return [clamp(c[0] + 0.03 * (1 - c[0])), clamp(c[1] + 0.012 * highlight), clamp(c[2] * 0.97)];
  }
  // 四张情绪专属 LUT：每种情绪一套色彩映射，身份差异由曲线本身承载。
  if (look === "happy") {
    // 暖金：高光带暖橙，整体轻提暖色与亮度。
    return [
      clamp(c[0] + 0.045 * highlight + 0.02 * (1 - c[0])),
      clamp(c[1] + 0.015 * highlight),
      clamp(c[2] * 0.9 + 0.01 * shadow),
    ];
  }
  if (look === "sad") {
    // 冷灰褪色：低饱和、抬黑、阴影偏蓝、压高光。
    return [
      clamp(c[0] * 0.9 + 0.055 - 0.02 * highlight),
      clamp(c[1] * 0.9 + 0.06 - 0.015 * highlight),
      clamp(c[2] * 0.9 + 0.075 + 0.03 * shadow - 0.01 * highlight),
    ];
  }
  if (look === "relaxed") {
    // 柔和高光：抬黑压白的粉彩雾化，画面像蒙一层柔光纱。
    return [clamp(c[0] * 0.74 + 0.17), clamp(c[1] * 0.74 + 0.165), clamp(c[2] * 0.74 + 0.175)];
  }
  // aggressive 冷硬：S 曲线拉对比，阴影偏青、高光留一丝暖（橙青色调）。
  const curved = c.map((channel) => channel + (channel * channel * (3 - 2 * channel) - channel) * 0.6);
  return [
    clamp(curved[0] - 0.03 * shadow + 0.025 * highlight),
    clamp(curved[1] + 0.012 * shadow),
    clamp(curved[2] + 0.06 * shadow - 0.015 * highlight),
  ];
}

export function createLut(look: Look): Uint8Array {
  const data = new Uint8Array(LUT_SIZE ** 3 * 4);
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const color = gradeColor([r / (LUT_SIZE - 1), g / (LUT_SIZE - 1), b / (LUT_SIZE - 1)], look);
        const offset = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4;
        data[offset] = Math.round(color[0] * 255);
        data[offset + 1] = Math.round(color[1] * 255);
        data[offset + 2] = Math.round(color[2] * 255);
        data[offset + 3] = 255;
      }
    }
  }
  return data;
}

import { LUT_SIZE } from "./luts";

export const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const GRADE = `
precision highp float;
precision highp sampler3D;
uniform sampler2D uTexture;
uniform sampler3D uDarkLut;
uniform sampler3D uCalmLut;
uniform sampler3D uBrightLut;
uniform float uUvScaleX;
uniform float uUvScaleY;
uniform float uContrast;
uniform float uBrightness;
uniform float uTemperature;
uniform float uShadowCool;
uniform float uHighlightThr;
uniform float uLookDark;
uniform float uLookCalm;
uniform float uLookBright;
uniform float uSoftClip;
uniform float uSaturation;
uniform float uGammaMid;
in vec2 vUv;
out vec4 outColor;

vec2 sourceUv() {
  return (vUv - 0.5) * vec2(uUvScaleX, uUvScaleY) + 0.5;
}

vec3 grade(vec3 source) {
  vec3 c = ((source - 0.5) * uContrast + 0.5) * uBrightness;
  // AI 模式用高光肩部把 >0.75 的亮度平滑压向 1，提亮时保留高光层次；默认模式走原硬截断。
  float knee = 0.75;
  vec3 over = max(c - knee, 0.0);
  vec3 shoulder = knee + over * (1.0 - knee) / ((1.0 - knee) + over);
  c = mix(clamp(c, 0.0, 1.0), clamp(shoulder, 0.0, 1.0), step(knee, c) * uSoftClip);
  vec3 uvw = (c * ${LUT_SIZE - 1}.0 + 0.5) / ${LUT_SIZE}.0;
  float total = uLookDark + uLookCalm + uLookBright;
  c = c * max(0.0, 1.0 - total)
    + texture(uDarkLut, uvw).rgb * uLookDark
    + texture(uCalmLut, uvw).rgb * uLookCalm
    + texture(uBrightLut, uvw).rgb * uLookBright;
  vec3 temperature = uTemperature < 0.0
    ? mix(vec3(1.0), vec3(1.08, 1.0, 0.9), -uTemperature)
    : mix(vec3(1.0), vec3(0.88, 0.97, 1.12), uTemperature);
  c *= temperature;
  float luminance = clamp(dot(c, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
  c = mix(c, c * vec3(0.85, 0.95, 1.15), (1.0 - luminance) * uShadowCool);
  // 中间调 gamma 与饱和度（与 pixijs/filters adjustment 相同的公式），中性值 1 时无效果。
  c = pow(max(c, 0.0), vec3(1.0 / uGammaMid));
  float gray = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(gray), c, uSaturation);
  return clamp(c, 0.0, 1.0);
}
`;

export const HIGHLIGHT_SHADER = `#version 300 es
${GRADE}
void main() {
  vec3 c = grade(texture(uTexture, sourceUv()).rgb);
  float luminance = dot(c, vec3(0.299, 0.587, 0.114));
  outColor = vec4(c * smoothstep(uHighlightThr, 1.0, luminance), 1.0);
}
`;

export const BLUR_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uDirection;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTexture, vUv).rgb * 0.227027;
  c += texture(uTexture, vUv + uDirection * 1.384615).rgb * 0.316216;
  c += texture(uTexture, vUv - uDirection * 1.384615).rgb * 0.316216;
  c += texture(uTexture, vUv + uDirection * 3.230769).rgb * 0.070270;
  c += texture(uTexture, vUv - uDirection * 3.230769).rgb * 0.070270;
  outColor = vec4(c, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
${GRADE}
uniform sampler2D uBloomTex0;
uniform sampler2D uBloomTex1;
uniform sampler2D uBloomTex2;
uniform float uTime;
uniform float uBypass;
uniform float uVignette;
uniform float uGrain;
uniform float uBloom;
uniform float uBloomWarm;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 source = texture(uTexture, sourceUv()).rgb;
  if (uBypass > 0.5) {
    outColor = vec4(source, 1.0);
    return;
  }
  vec3 c = grade(source);
  if (uBloom + uBloomWarm > 0.0) {
    // 三级多尺度柔光（结构参考 three.js UnrealBloomPass，MIT）：近处清晰光晕 + 远处宽扩散，权重归一。
    vec3 glow = texture(uBloomTex0, vUv).rgb * 0.55
      + texture(uBloomTex1, vUv).rgb * 0.30
      + texture(uBloomTex2, vUv).rgb * 0.15;
    vec3 amount = clamp(glow * (uBloom * vec3(0.9, 0.95, 1.0)
      + uBloomWarm * vec3(0.6, 0.35, 0.15)), 0.0, 0.75);
    c = 1.0 - (1.0 - c) * (1.0 - amount);
  }
  float vignette = 1.0 - smoothstep(0.45, 0.85, distance(vUv, vec2(0.5)));
  c *= mix(1.0, vignette, uVignette);
  // 胶片颗粒：2px 颗粒块按 24fps 跳变，暗部重、亮部轻（胶片特性），避免白色雪花感。
  float frame = mod(floor(uTime * 24.0), 4096.0);
  vec2 cell = floor(gl_FragCoord.xy * 0.5) + frame * vec2(17.0, 31.0);
  float noise = hash(cell) - 0.5;
  float response = 1.0 - smoothstep(0.35, 0.8, clamp(dot(c, vec3(0.299, 0.587, 0.114)), 0.0, 1.0)) * 0.75;
  c += noise * uGrain * response;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const COPY_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTexture, vUv).rgb, 1.0);
}
`;

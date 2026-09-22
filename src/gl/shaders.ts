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
in vec2 vUv;
out vec4 outColor;

vec2 sourceUv() {
  return (vUv - 0.5) * vec2(uUvScaleX, uUvScaleY) + 0.5;
}

vec3 grade(vec3 source) {
  vec3 c = clamp(((source - 0.5) * uContrast + 0.5) * uBrightness, 0.0, 1.0);
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
uniform sampler2D uBloomTexture;
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
    vec3 glow = texture(uBloomTexture, vUv).rgb;
    vec3 amount = clamp(glow * (uBloom * vec3(0.9, 0.95, 1.0)
      + uBloomWarm * vec3(0.6, 0.35, 0.15)), 0.0, 0.75);
    c = 1.0 - (1.0 - c) * (1.0 - amount);
  }
  float vignette = 1.0 - smoothstep(0.45, 0.85, distance(vUv, vec2(0.5)));
  c *= mix(1.0, vignette, uVignette);
  float noise = hash(gl_FragCoord.xy + mod(floor(uTime * 30.0), 4096.0) * 17.0) - 0.5;
  c += noise * uGrain;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

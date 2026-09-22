// GLSL ES 3.00。顶点 shader 用 gl_VertexID 生成覆盖全屏的大三角形，不需要顶点缓冲。
export const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

// 单 pass 演示滤镜，特征映射遵循架构文档 §4.5：
// RMS → 光晕强度；Bass → 暖色高光扩散；Treble → 颗粒活跃度；
// Onset → 瞬时对比度；Centroid → 色温。
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uRms;
uniform float uBass;
uniform float uTreble;
uniform float uOnset;
uniform float uCentroid;
uniform float uIntensity;
uniform float uBypass;

in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 src = texture(uTexture, vUv).rgb;
  vec3 c = src;

  float contrast = 1.12 + uOnset * uIntensity * 0.35;
  c = (c - 0.5) * contrast + 0.5;
  c *= 0.95;

  float lum = dot(c, vec3(0.299, 0.587, 0.114));

  vec3 warm = vec3(1.08, 1.0, 0.9);
  vec3 cool = vec3(0.88, 0.97, 1.12);
  c *= mix(warm, cool, clamp(uCentroid, 0.0, 1.0));

  c = mix(c, c * vec3(0.85, 0.95, 1.15), (1.0 - lum) * 0.35);

  float highlight = smoothstep(0.55, 1.0, lum);
  c += highlight * uRms * uIntensity * vec3(0.9, 0.95, 1.0) * 0.7;
  c += highlight * uBass * uRms * uIntensity * vec3(0.6, 0.35, 0.15);

  float dist = distance(vUv, vec2(0.5));
  c *= smoothstep(0.85, 0.45, dist);

  float grain = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5;
  c += grain * (0.03 + uTreble * uIntensity * 0.12);

  c = clamp(c, 0.0, 1.0);
  outColor = vec4(mix(c, src, uBypass), 1.0);
}
`;

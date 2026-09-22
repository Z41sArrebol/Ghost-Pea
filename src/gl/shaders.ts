// GLSL ES 3.00。顶点 shader 用 gl_VertexID 生成覆盖全屏的大三角形，不需要顶点缓冲。
export const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

// 单 pass 演示滤镜。所有效果强度都是 uniform，由参数面板实时调整。
// 动态特征映射遵循架构文档 §4.5：
// RMS → 光晕；Bass → 暖色高光扩散；Treble → 颗粒；Onset → 瞬时对比；Centroid → 色温。
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uTexture;
uniform float uUvScaleX;
uniform float uUvScaleY;
uniform float uTime;
uniform float uRms;
uniform float uBass;
uniform float uTreble;
uniform float uOnset;
uniform float uCentroid;
uniform float uIntensity;
uniform float uBypass;
uniform float uBaseContrast;
uniform float uBrightness;
uniform float uVignette;
uniform float uGrainBase;
uniform float uHighlightThr;
uniform float uShadowCool;
uniform float uMapRmsGlow;
uniform float uMapBassWarm;
uniform float uMapTrebleGrain;
uniform float uMapOnsetContrast;
uniform float uMapCentroidTemp;

in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  // 铺满模式下 uvScale < 1，只采样纹理中心区域实现裁剪
  vec2 uv = (vUv - 0.5) * vec2(uUvScaleX, uUvScaleY) + 0.5;
  vec3 src = texture(uTexture, uv).rgb;
  vec3 c = src;

  float contrast = uBaseContrast + uOnset * uIntensity * uMapOnsetContrast;
  c = (c - 0.5) * contrast + 0.5;
  c *= uBrightness;

  float lum = dot(c, vec3(0.299, 0.587, 0.114));

  // 色温：centroid 高于中值偏冷、低于偏暖；系数或全局强度为 0 时回到中性
  vec3 warm = vec3(1.08, 1.0, 0.9);
  vec3 cool = vec3(0.88, 0.97, 1.12);
  float tempMix = clamp(0.5 + (uCentroid - 0.5) * uMapCentroidTemp * uIntensity, 0.0, 1.0);
  c *= mix(warm, cool, tempMix);

  c = mix(c, c * vec3(0.85, 0.95, 1.15), (1.0 - lum) * uShadowCool);

  float highlight = smoothstep(uHighlightThr, 1.0, lum);
  c += highlight * uRms * uIntensity * uMapRmsGlow * vec3(0.9, 0.95, 1.0);
  c += highlight * uBass * uRms * uIntensity * uMapBassWarm * vec3(0.6, 0.35, 0.15);

  float dist = distance(vUv, vec2(0.5));
  float vig = smoothstep(0.85, 0.45, dist);
  c *= mix(1.0, vig, uVignette);

  float grain = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5;
  c += grain * (uGrainBase + uTreble * uIntensity * uMapTrebleGrain);

  c = clamp(c, 0.0, 1.0);
  outColor = vec4(mix(c, src, uBypass), 1.0);
}
`;

# ghost-pea 技术架构

## 1. 文档目标

本文定义 Hackathon MVP 的技术边界、组件职责、数据流、实时性约束和后续 AI 扩展方式。

核心原则：

- 视频帧留在前端 GPU 链路，不经过 Tauri IPC。
- 快速音频响应不依赖 AI，AI 失败时基础动态滤镜仍正常工作。
- AI 只判断较慢的氛围状态，不直接控制每一帧 Shader 参数。
- MVP 使用 UVC 标准能力，不接入厂商 C++ SDK。
- OBS 负责录制和虚拟摄像头输出，不自研视频编码或虚拟摄像头驱动。

## 2. 总体架构

```text
Windows 系统音频
        ↓ WASAPI Loopback
Rust 音频采集
        ├─ 快速 DSP：RMS / Bass / Mid / Treble / Onset / Centroid
        │                       ↓ 30–60 Hz 参数事件
        └─ 16 kHz 单声道 PCM 滑动窗口
                                ↓ 0.5–2 Hz 二进制 Channel
                         前端 Web Worker
                                ↓
                    Essentia.js + TensorFlow.js
                                ↓
              Happy / Sad / Relaxed / Aggressive
                                ↓
                         氛围状态编排器
                                ↓
                  Calm / Bright / Intense / Dark
                                ↓
UVC 相机 → getUserMedia → PixiJS Video Texture
                                ↓
              WebGL2 Filter / Fragment Shader
                                ↓
                  Tauri 窗口 / OBS Window Capture
                                ↓
              Recording / Streaming / Virtual Camera
```

## 3. 技术栈

### 3.1 桌面容器

- Tauri 2。
- Rust stable。
- TypeScript + Vite。
- 前端框架可选 React、Vue 或 Svelte，仅负责界面状态和控件。

### 3.2 Rust 后端

- `wasapi`：Windows 系统音频回环采集。
- `ringbuf`：音频回调与分析线程之间的有界环形缓冲。
- `realfft`：频谱、频段能量和 spectral centroid。
- `rubato`：为 AI 链路转换到 16 kHz 单声道。
- Tauri Event：发送低带宽实时特征和状态。
- Tauri Channel：发送 AI 所需的 PCM 二进制窗口。

### 3.3 前端视频与渲染

- `navigator.mediaDevices.getUserMedia()`：访问 USB/UVC 相机。
- `requestVideoFrameCallback()`：跟随相机帧更新视频纹理。
- PixiJS：管理 Video Texture、渲染循环和 Filter Chain。
- WebGL2：执行自定义 Fragment Shader。
- `pixi-filters`：仅复用适合的基础效果，核心摄影风格使用自定义 Filter。

### 3.4 AI 推理

- Essentia.js：音频特征预处理，运行于 Web Worker。
- TensorFlow.js：加载 Essentia 兼容的 TF.js 模型。
- MVP 可选模型：`mood_happy`、`mood_sad`、`mood_relaxed`、`mood_aggressive`。
- AI 为可关闭增强项；默认规则链路不依赖模型。

### 3.5 输出

- Tauri 窗口显示最终 Canvas。
- OBS Window Capture 捕获应用画面。
- OBS 负责录制、直播和 Virtual Camera。

## 4. 组件职责

### 4.1 音频采集线程

音频回调只执行：

1. 读取 WASAPI Loopback 样本。
2. 做必要的轻量格式转换。
3. 写入预分配的有界环形缓冲。

禁止在音频回调中执行 FFT、AI 推理、日志、文件写入、IPC 和可能阻塞的锁等待。

### 4.2 快速 DSP 线程

更新频率为 60 至 100 Hz，计算：

- RMS 和归一化能量。
- Bass、Mid、Treble 能量。
- Onset。
- Spectral centroid。
- 能量变化方向和静音状态。

向前端发送的控制快照不高于 60 Hz，并携带递增序号和采集时间戳。

### 4.3 AI 窗口生产线程

- 将系统音频降采样为 16 kHz 单声道。
- 维护最近 2 至 5 秒的滑动窗口。
- 每 0.5 至 2 秒向前端 Web Worker 发送一次 PCM 二进制数据。
- 缓冲区必须有界；消费者落后时丢弃旧窗口，只保留最新窗口。

### 4.4 AI Web Worker

- 加载 Essentia.js WASM 和 TensorFlow.js 模型。
- 启动时完成模型预热。
- 输出各情绪标签概率及推理耗时。
- 不访问 DOM，不运行 PixiJS 渲染循环。
- 推理异常、超时或模型未加载时输出不可用状态，不阻塞快速链路。

### 4.5 参数编排器

编排器位于前端渲染层附近，组合快速特征与慢速 AI 状态：

```text
最终参数 = 主题基础值 + AI 状态偏移 + 快速音频调制
```

快速映射建议：

| 输入     | 主要控制                 |
| -------- | ------------------------ |
| RMS      | Bloom 强度、整体动态幅度 |
| Bass     | Halation、高光扩散       |
| Mid      | 局部对比度、主体清晰度   |
| Treble   | 颗粒活跃度、边缘质感     |
| Onset    | 短时局部对比变化         |
| Centroid | 色温和高光色彩倾向       |

慢速状态映射建议：

| 模型输出      | 产品状态 | 作用                       |
| ------------- | -------- | -------------------------- |
| Relaxed 高    | Calm     | 柔和对比、低动态幅度       |
| Happy 高      | Bright   | 暖色、高亮度和中等饱和度   |
| Aggressive 高 | Intense  | 更高对比和更活跃质感       |
| Sad 高        | Dark     | 冷阴影、较低亮度和高光压缩 |
| 置信度不足    | Neutral  | 保持当前状态或回到基础主题 |

编排器必须实现：

- Attack / Release。
- 参数最小值、最大值和默认值。
- 单位时间最大变化量。
- 最短状态保持时间，默认 2 秒。
- 状态切换交叉淡化，默认 0.5 至 2 秒。
- 静音回落。
- 全局动态强度。
- 曝光和频闪硬限制。

### 4.6 视频渲染层

视频链路完全留在 WebView2 前端：

```text
HTMLVideoElement
→ PixiJS Video Texture
→ 基础色彩/LUT
→ Tone Curve / Local Contrast
→ Bloom / Halation
→ Grain / Vignette
→ Canvas
```

不得将相机视频帧发送给 Rust。React、Vue 或 Svelte 不参与逐帧处理，只管理控件和状态。

## 5. 数据契约

### 5.1 快速控制快照

逻辑字段：

```text
sequence
captured_at
rms
bass
mid
treble
onset
centroid
energy_trend
silence
```

所有连续特征进入前端前归一化到约定范围。前端收到序号倒退或过旧数据时直接丢弃。

### 5.2 AI 输入窗口

- 格式：`Float32` PCM。
- 通道：单声道。
- 采样率：16 kHz。
- 长度：2 至 5 秒。
- 传输：二进制 Channel，不使用 JSON 数组。

### 5.3 AI 输出

```text
happy
sad
relaxed
aggressive
confidence
inference_ms
model_ready
```

AI 输出只改变主题内部的参数范围和长期目标，不直接触发高频画面变化。

## 6. 并发与降级

- 音频采集、快速 DSP、AI 窗口生产和前端 AI 推理相互隔离。
- 所有跨线程队列必须有界。
- AI 超时：保持当前状态，快速 DSP 继续工作。
- 音频中断：停止动态调制并平滑回到主题基础值。
- 相机断开：显示明确错误状态，不继续报告正常输出。
- FPS 持续下降：依次关闭视觉 AI、关闭音频 AI、降至 720p、减少滤镜 pass。
- WebGL2 初始化失败：显示错误并阻止进入演示模式。

## 7. 实时性预算

快速响应链路不等待 AI：

| 环节                     |    目标延迟 |
| ------------------------ | ----------: |
| WASAPI Loopback          |    5–15 ms |
| 快速特征分析             |    5–12 ms |
| Tauri 参数事件           |   0.2–2 ms |
| 等待下一渲染帧           | 平均 8.3 ms |
| PixiJS / WebGL2 Shader   |     2–8 ms |
| OBS Window Capture，可选 |   15–35 ms |
| 本地预览典型合计         |   16–45 ms |
| OBS 输出典型合计         |   31–80 ms |

AI 链路允许 0.5 至 2 秒更新周期，不计入声音到画面快速响应指标。

## 8. MVP 边界

### P0

- UVC 相机预览。
- WASAPI Loopback。
- 快速音频特征。
- 一个完整 PixiJS/WebGL2 动态滤镜。
- 参数平滑、限制和静音回落。
- 强度控制和 A/B。
- 本地窗口输出与 OBS Window Capture。

### P1

- Calm、Bright、Dark 三个主题。
- FPS、延迟、相机和音频状态。
- OBS 录制与 Virtual Camera。
- 参数录制与回放。

### P2

- Essentia.js 音乐氛围分类。
- 人脸保护和人物分割。
- 氛围封面和参数轨迹。
- 原生录制、Spout 或厂商 SDK。

## 9. 后续演进

比赛后可将 AI 推理迁移到 Rust：

```text
Rust PCM
→ 同构 Log-Mel 预处理
→ ONNX Runtime (`ort`)
→ 情绪概率
```

迁移前必须使用同一段测试音频，对比 Essentia.js 与 Rust 的预处理张量和模型输出。正式商业化还需重新评估 Essentia.js 的 AGPLv3，以及预训练模型常见的 CC BY-NC-SA 4.0 许可。

长期还可以逐步加入：

- 原生 `wgpu` 视频渲染。
- 厂商 C++ SDK 的薄 C ABI 适配层。
- 原生视频编码。
- Spout 或自有虚拟摄像头输出。
- 相机端 ISP、GPU 或 NPU 部署。

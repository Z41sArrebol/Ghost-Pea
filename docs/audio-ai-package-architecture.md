# Ghost Pea 前端 AI 包架构

## 1. 文档范围

本文定义 `packages/audio-ai` 的职责、内部结构、数据流，以及它与 Rust 音频后端和前端页面的接口边界。

本文不定义页面结构、UI 状态管理、滤镜参数映射，也不确定四个情绪分类器分数的最终融合算法。

## 2. 设计目标

- AI 能力独立于 React 和具体页面，前端大改时无需修改推理实现。
- AI 包直接接入 Rust 提供的 AI PCM Channel，页面不手动转发 PCM。
- Essentia.js 特征提取和 TensorFlow.js 推理全部运行在 Web Worker 中，不阻塞页面和渲染循环。
- 推理消费者落后时只保留最新 PCM 窗口，不建立无界队列。
- AI 加载、推理或通信失败时，不影响快速 DSP、相机预览和基础滤镜。
- 对外接口保持稳定，使模型和分数融合策略可以独立替换。

## 3. 所有权边界

### 3.1 AI 包负责

- 建立和释放 Rust AI PCM Channel。
- 解析、校验后端二进制 PCM 数据。
- 管理 Web Worker 生命周期。
- 实现 latest-only 推理调度。
- 加载 Essentia.js、TensorFlow.js 后端和模型资源。
- 从 16 kHz 单声道 PCM 提取模型所需特征。
- 执行情绪模型推理并输出标准化结果。
- 报告初始化、运行、降级和错误状态。
- 提供框架无关的 TypeScript 公共 API。

### 3.2 Rust 音频后端负责

- WASAPI Loopback 音频采集。
- 下混和重采样为 16 kHz 单声道 `f32` PCM。
- 维护固定 3 秒窗口和 1 秒步长。
- 通过 Tauri Channel 发送带协议头的二进制窗口。
- 管理丢样、`streamEpoch`、序号和运行统计。
- 保证 AI 链路故障不影响快速 DSP 链路。

后端契约以 `audio-monitor-api.md` 为准。AI 包不重新采集音频，不使用 Web Audio API，也不重复执行重采样。

### 3.3 前端页面负责

- 决定何时启用或停用 AI 功能。
- 确保音频监听已启动，再启动 AI 服务。
- 订阅 AI 结果和状态，并展示必要信息。
- 将 AI 结果交给参数编排器。
- 在页面卸载时取消订阅并释放服务。
- 在应用构建中提供可访问的模型资源 URL。

前端页面不负责：

- 解析后端 PCM 二进制协议。
- 调用 Worker 的 `postMessage`。
- 管理推理队列和模型实例。
- 依赖 Essentia.js 或 TensorFlow.js 的内部类型。
- 实现 AI 模型的概率后处理。

React Hook、Vue composable 或其他框架适配器属于前端代码，不进入 AI 核心包。

## 4. 总体数据流

```text
Rust WASAPI / DSP
        ↓
16 kHz mono Float32 PCM，3 秒窗口，1 秒步长
        ↓ Tauri Channel
TauriPcmSource
        ├─ 校验协议头
        ├─ 检查 streamEpoch / sequence
        └─ 提取 PCM ArrayBuffer
        ↓
latest-only 单槽调度器
        ↓ transferable postMessage
AI Web Worker
        ├─ Essentia.js MusiCNN 特征提取
        ├─ TensorFlow.js 模型推理
        └─ 原始情绪分数及耗时
        ↓
AudioMoodService
        ↓ subscribe
前端状态层 / 参数编排器
```

Tauri Channel 的回调发生在 WebView JavaScript 环境，不能直接连接 Web Worker。因此 PCM 会在 AI 包内部经过主线程适配器，再以 Transferable 转移给 Worker。该过程不暴露给页面。

## 5. 包结构

```text
packages/audio-ai/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ index.ts                    # 公共 API 和公共类型
│  ├─ service/
│  │  └─ AudioMoodService.ts      # 对外服务、状态与订阅
│  ├─ tauri/
│  │  ├─ TauriPcmSource.ts        # Channel 和 Command 适配
│  │  └─ decodePcmWindow.ts       # 二进制协议解析及校验
│  ├─ worker/
│  │  ├─ mood.worker.ts           # Worker 入口
│  │  ├─ protocol.ts              # 主线程与 Worker 消息协议
│  │  └─ scheduler.ts             # latest-only 调度
│  ├─ inference/
│  │  ├─ featureExtractor.ts      # Essentia.js 特征提取
│  │  ├─ modelRuntime.ts          # TF.js 初始化、加载和预热
│  │  └─ classify.ts              # 模型推理与原始分数归一化
│  └─ contracts/
│     ├─ pcm.ts                   # 后端 PCM 窗口类型
│     ├─ result.ts                # 公共推理结果类型
│     └─ status.ts                # 生命周期和错误类型
└─ tests/
   ├─ decodePcmWindow.test.ts
   ├─ scheduler.test.ts
   └─ fixtures/
```

模型权重不直接作为 TypeScript 源码导入。AI 包定义模型清单和预期文件结构，宿主应用负责将模型文件作为静态资源部署，并在初始化时传入 `modelBaseUrl`。

## 6. 后端接口

### 6.1 Tauri Commands

AI 包内部调用：

```text
start_ai_pcm_stream(channel)
stop_ai_pcm_stream
ai_pcm_status
```

`start_ai_pcm_stream` 的前置条件是 Rust 音频监听已经处于 `running`。AI 服务不自动调用 `start_audio_monitor` 或 `stop_audio_monitor`，避免与页面中其他音频功能争夺全局生命周期。

### 6.2 PCM 二进制协议

所有字段使用小端序：

| 偏移 | 长度 | 类型 | 内容 |
| ---: | ---: | --- | --- |
| 0 | 4 | `u32` | 协议版本，当前为 `1` |
| 4 | 4 | `u32` | 采样率，当前为 `16000` |
| 8 | 4 | `u32` | 样本数，当前为 `48000` |
| 12 | 4 | `u32` | 保留字段 |
| 16 | 8 | `u64` | `streamEpoch` |
| 24 | 8 | `u64` | `sequence` |
| 32 | 变长 | `f32[]` | 单声道 PCM |

解析器必须验证协议版本、采样率、样本数和总长度。`streamEpoch` 或 `sequence` 在 TypeScript 中使用 `bigint`，不得转换为可能丢失精度的 `number`。

epoch 变化表示音频连续性中断。AI 包丢弃等待中的旧窗口，并从新 epoch 重新开始；不同 epoch 的序号不进行连续性比较。

## 7. 提供给前端的公共 API

AI 包对页面只暴露服务工厂、服务接口和稳定的数据类型：

```ts
export interface AudioMoodServiceOptions {
  modelBaseUrl: string;
}

export interface AudioMoodService {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (result: MoodResult) => void): () => void;
  subscribeStatus(listener: (status: AudioMoodStatus) => void): () => void;
  getStatus(): AudioMoodStatus;
  dispose(): Promise<void>;
}

export function createTauriAudioMoodService(
  options: AudioMoodServiceOptions,
): AudioMoodService;
```

页面使用方式：

```ts
import { createTauriAudioMoodService } from "@ghost-pea/audio-ai";

const service = createTauriAudioMoodService({
  modelBaseUrl: "/models/audio-ai",
});

await service.start();

const unsubscribe = service.subscribe((result) => {
  orchestrator.updateMood(result);
});
```

`pushPcm` 仅为 AI 包内部的 Worker 客户端方法，不从包的公共入口导出。前端页面不会接触 PCM。

## 8. 公共结果与状态

初始公共结果保留原始模型信息，不提前绑定页面或滤镜参数：

```ts
export interface MoodScores {
  happy: number;
  sad: number;
  relaxed: number;
  aggressive: number;
}

export interface MoodResult {
  streamEpoch: bigint;
  sequence: bigint;
  scores: MoodScores;
  confidence: number;
  inferenceMs: number;
}
```

`confidence` 的最终定义和四个分类器分数的融合方式暂不确定。后续可以采用阈值规则、时间平滑、逻辑回归或其他校准方法，但不得改变 `scores` 原始输出的语义。

建议的服务状态：

```ts
export type AudioMoodPhase =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "degraded"
  | "failed"
  | "disposed";

export interface AudioMoodStatus {
  phase: AudioMoodPhase;
  modelReady: boolean;
  backendConnected: boolean;
  lastError: string | null;
}
```

## 9. Worker 与过载策略

- 页面主线程只负责接收 Channel 消息、校验头部和转移 PCM 所有权。
- Worker 忙碌时，新窗口覆盖尚未开始推理的旧窗口。
- 任意时刻最多存在一个正在推理的窗口和一个待推理窗口。
- Worker 完成当前推理后立即取最新待处理窗口。
- 旧 epoch 的待处理窗口必须丢弃。
- Worker 初始化时加载模型并执行一次预热，然后才报告 `ready`。
- `dispose` 必须终止 Worker、停止 AI PCM Channel、释放 Essentia WASM 和 TF.js 模型资源。

## 10. 模型和依赖方案

MVP 候选模型：

```text
mood_happy-msd-musicnn
mood_sad-msd-musicnn
mood_relaxed-msd-musicnn
mood_aggressive-msd-musicnn
```

四个模型是独立二分类器。一次 Essentia.js 特征提取的结果应复用于四次模型推理，不能重复提取四次。

候选运行依赖：

```text
essentia.js
@tensorflow/tfjs
@tensorflow/tfjs-backend-wasm
```

Tauri 适配层依赖 `@tauri-apps/api`。具体版本和依赖声明方式在实现前通过最小 Worker 原型验证后确定，当前文档不锁定版本。

Essentia.js 使用 AGPLv3；MTG 提供的模型通常使用 CC BY-NC-SA 4.0 或其模型目录中声明的许可。Hackathon 可以用于演示，商业化前必须重新审查并替换或取得授权。

## 11. TypeScript 约定

AI 包使用 TypeScript，实现和发布公共类型，但不依赖任何前端框架类型。

- 公共 API 使用独立的 `tsconfig.json`。
- Worker 使用 Web Worker 类型环境。
- 二进制输入必须进行运行时校验，不能只依赖静态类型。
- 包对外生成 JavaScript 和 `.d.ts`，前端不直接编译 AI 包源码。
- Worker 入口和 WASM 资源必须通过 Vite/Tauri 构建验证。

## 12. 生命周期与降级

推荐启动顺序：

1. 前端启动 Rust 音频监听。
2. 前端调用 AI 服务 `start()`。
3. AI 服务创建 Worker并加载、预热模型。
4. AI 服务建立 Tauri PCM Channel。
5. 收到窗口后开始 latest-only 推理。
6. AI 服务向订阅者发布结果。

推荐停止顺序：

1. 前端调用 AI 服务 `stop()`。
2. AI 服务调用 `stop_ai_pcm_stream`。
3. 清空待推理窗口并停止发布结果。
4. 页面按自身需要决定是否停止全局音频监听。

模型加载失败、推理异常或 Channel 中断时，AI 服务进入 `degraded` 或 `failed`，停止发布伪正常结果，但不调用 `stop_audio_monitor`，不影响快速 DSP 和视频渲染。

## 13. 待确定事项

- 四个二分类分数的校准与融合算法。
- `confidence` 的精确定义。
- Neutral 判定、迟滞、状态保持和时间平滑策略。
- 四模型全部常驻，还是按设备性能选择部分模型。
- TensorFlow.js WASM 与 WebGL 后端在目标设备上的性能对比。
- 模型文件的最终部署路径、体积和 Tauri 打包方式。
- AI 包的构建器、测试框架和正式依赖版本。

这些事项不影响当前与 Rust 后端及前端页面之间的接口边界。
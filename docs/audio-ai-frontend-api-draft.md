# Audio AI 前端 API（Draft v0.1）

> 状态：联调草案，非最终 API。
>
> 本文用于向前端同学展示计划中的接入方式。接口名称、状态字段和结果结构仍可能调整；四个模型分数的融合算法尚未确定。

## 1. 前端需要做什么

前端只负责：

1. 先启动全局音频监听。
2. 创建并启动 Audio AI 服务。
3. 订阅推理结果和服务状态。
4. 将结果交给页面状态或参数编排器。
5. 页面或功能退出时取消订阅并释放服务。

前端不需要处理 PCM、Tauri Channel、Web Worker、Essentia.js 或 TensorFlow.js。

## 2. 当前接入方式

依赖已经通过 pnpm workspace 提供：

```ts
import { createTauriAudioMoodService } from "@ghost-pea/audio-ai";
```

最小示例：

```ts
const audioMood = createTauriAudioMoodService({
  modelBaseUrl: "/models/audio-ai",
});

const unsubscribeResult = audioMood.subscribe((result) => {
  console.log(result.scores);
});

const unsubscribeStatus = audioMood.subscribeStatus((status) => {
  console.log(status.phase, status.lastError);
});

await audioMood.start();

// 页面或功能退出时
unsubscribeResult();
unsubscribeStatus();
await audioMood.dispose();
```

## 3. 公共 API

### 创建服务

```ts
interface AudioMoodServiceOptions {
  modelBaseUrl: string;
}

function createTauriAudioMoodService(
  options: AudioMoodServiceOptions,
): AudioMoodService;
```

`modelBaseUrl` 是模型静态资源目录。当前占位推理不会读取该目录，但真实模型接入后会使用。

### 服务接口

```ts
interface AudioMoodService {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (result: MoodResult) => void): () => void;
  subscribeStatus(listener: (status: AudioMoodStatus) => void): () => void;
  getStatus(): AudioMoodStatus;
  dispose(): Promise<void>;
}
```

| 方法 | 说明 |
| --- | --- |
| `start()` | 启动 AI Worker，并连接 Rust AI PCM Channel |
| `stop()` | 停止 AI PCM Channel，并终止当前 Worker |
| `subscribe()` | 订阅推理结果，返回取消订阅函数 |
| `subscribeStatus()` | 订阅服务状态；注册后会立即收到当前状态 |
| `getStatus()` | 同步读取当前状态快照 |
| `dispose()` | 完全释放服务；调用后不能再次启动 |

同一个服务实例不要并发调用多次 `start()` 或 `stop()`。前端应在自己的生命周期层串行管理启停。

## 4. 启动前置条件

`start()` 不会自动启动全局音频监听。前端应先确保 Rust 音频监听处于 `running`：

```ts
import { invoke } from "@tauri-apps/api/core";

await invoke("start_audio_monitor");
await audioMood.start();
```

这是有意保留的边界：音频监听同时服务快速 DSP 和 AI，不应由 AI 包独占其生命周期。

如果音频监听尚未运行，`audioMood.start()` 会拒绝 Promise，前端应捕获并展示适合页面的错误状态。

## 5. 推理结果

```ts
interface MoodScores {
  happy: number;
  sad: number;
  relaxed: number;
  aggressive: number;
}

interface MoodResult {
  streamEpoch: bigint;
  sequence: bigint;
  scores: MoodScores;
  confidence: number;
  inferenceMs: number;
  modelReady: boolean;
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `streamEpoch` | 音频连续性标识；丢样或重启流时变化 |
| `sequence` | 当前 epoch 内的窗口递增序号 |
| `scores` | 四个独立二分类器最近 8 个窗口的正类分数均值 |
| `confidence` | 最高分相对第二名的领先比例，范围为 `0..1` |
| `inferenceMs` | Worker 内本次推理耗时 |
| `modelReady` | 真实模型是否已经加载 |

注意：

- 四个 `scores` 是独立分数，不保证总和为 `1`。
- 不同分类器未经过联合校准，分数绝对值和高低不能当作四分类概率解释。
- 当前使用最近 8 个重叠窗口做算术平均；静音或 epoch 变化会清空历史。
- `confidence = (最高分 - 第二名) / 最高分`；所有分数为零时为 `0`。
- 最终迟滞和最短状态保持策略仍待确定。
- `streamEpoch` 和 `sequence` 是 `bigint`。需要序列化到 JSON 时，应先转换为字符串。

## 6. 服务状态

```ts
type AudioMoodPhase =
  | "idle"
  | "loading"
  | "running"
  | "degraded"
  | "failed"
  | "disposed";

interface AudioMoodStatus {
  phase: AudioMoodPhase;
  modelReady: boolean;
  backendConnected: boolean;
  lastError: string | null;
}
```

| 状态 | 含义 |
| --- | --- |
| `idle` | 未启动或已停止 |
| `loading` | Worker 正在初始化 |
| `running` | 后端已连接且真实模型可用 |
| `degraded` | 通信链路可用，但模型或部分能力不可用 |
| `failed` | 启动或运行失败 |
| `disposed` | 服务已永久释放 |

`subscribeStatus()` 在订阅时会立即回调一次，前端不必额外调用 `getStatus()` 完成初始渲染。

## 7. React 接入示意

AI 包不提供 React Hook。前端可以在自己的集成层包装：

```ts
useEffect(() => {
  const service = createTauriAudioMoodService({
    modelBaseUrl: "/models/audio-ai",
  });

  const unsubscribeResult = service.subscribe(setMoodResult);
  const unsubscribeStatus = service.subscribeStatus(setMoodStatus);

  void service.start().catch((error) => {
    console.error("Audio AI failed to start", error);
  });

  return () => {
    unsubscribeResult();
    unsubscribeStatus();
    void service.dispose();
  };
}, []);
```

这段代码只是生命周期示意，不要求前端保留 React 或采用特定状态管理方案。

## 8. 当前实现状态

当前已完成：

- Rust AI PCM Channel 对接。
- 二进制协议解析和校验。
- PCM 序号去重与 epoch 处理。
- latest-only 调度。
- 独立 Web Worker 通信。
- 服务启停、状态订阅和结果订阅。
- Essentia.js MusiCNN 特征提取。
- 四个 TensorFlow.js 二分类模型加载和推理。
- 跨窗口分数平均及领先优势置信度。
- 静音窗口短路。

当前尚未完成：

- 针对目标音乐样本集的模型分数校准。
- 最终 Neutral 阈值、迟滞和最短保持策略。

模型资源从 `/models/audio-ai` 加载。加载和后端连接成功后，服务进入 `running` 且 `modelReady` 为 `true`。

## 9. 错误与降级

- `start()` 失败时会拒绝 Promise，并将状态切换为 `failed`。
- 单个 PCM 数据包无效时，服务进入 `degraded` 并通过 `lastError` 报告原因。
- AI 失败不会停止 Rust 全局音频监听。
- AI 失败不会影响快速 DSP、视频预览或基础滤镜。
- 前端应以 `phase` 和 `modelReady` 判断功能可用性，不要仅根据是否收到过结果判断。

## 10. 草案中可能变化的内容

在真实模型接入和前端联调后，以下内容可能调整：

- 工厂函数和状态字段命名。
- `modelBaseUrl` 的资源配置方式。
- `MoodResult` 中综合状态和置信度字段。
- 启停幂等性与自动恢复行为。
- 错误对象的结构化格式。

稳定不变的设计方向是：前端只负责启停和订阅，不接触 PCM、Tauri Channel、Worker 或模型内部实现。
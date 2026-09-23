# Audio Monitor 前端 API

## 1. 概述

Rust 后端通过 Tauri Command 提供音频监听的启动、停止和状态查询接口，通过 Tauri Event 主动推送快速 DSP 特征，并通过二进制 Tauri Channel 发送 AI PCM 窗口。默认播放设备的 loopback 与默认麦克风分别采集，麦克风在启动时约 2 秒的底噪校准期间以低增益参与合流，此后使用保留最低增益的软门限。麦克风不可用时记录后端日志，并继续使用播放音频；当前不支持设备选择。

- Command 用于生命周期控制和低频状态面板。
- `audio-features` Event 用于 30–60 Hz 动态滤镜驱动。
- AI PCM Channel 用于前端 Web Worker 的慢速模型输入，不应通过 JSON Event 传输。
- 前端不应通过高频轮询驱动滤镜。

## 2. 前端类型

```ts
export type AudioRuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface AudioStatus {
  running: boolean;
  state: AudioRuntimeState;
  lastError: string | null;
  sampleRateHz: number;
  channels: number;
  capturedFrames: number;
  droppedSamples: number;
  sequence: number;
  capturedAtUs: number;
  rms: number;
  bass: number;
  mid: number;
  treble: number;
  onset: number;
  centroid: number;
  energyTrend: number;
  silence: boolean;
  microphoneEnabled: boolean;
  microphoneLevel: number;
  microphoneGate: number;
  microphoneGain: number;
}

export interface AudioFeatures {
  sequence: number;
  capturedAtUs: number;
  rms: number;
  bass: number;
  mid: number;
  treble: number;
  onset: number;
  centroid: number;
  energyTrend: number;
  silence: boolean;
}

export interface DspPerformance {
  sampleCount: number;
  windowMs: number;
  lastUs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  maxUs: number;
  pipelineLagUs: number;
  deadlineMisses: number;
}

export interface AiPcmStatus {
  enabled: boolean;
  outputSampleRateHz: number;
  windowSamples: number;
  hopSamples: number;
  streamEpoch: number;
  sequence: number;
  emittedWindows: number;
  droppedInputSamples: number;
  bufferedInputSamples: number;
  lastError: string | null;
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `running` | `boolean` | 音频监听是否处于运行状态 |
| `state` | `AudioRuntimeState` | 监听生命周期状态，设备失效后为 `failed` |
| `lastError` | `string \| null` | 已启动会话的运行期错误；无错误时为 `null` |
| `sampleRateHz` | `number` | WASAPI 播放设备采样率，也是混合后送入 DSP 的采样率，例如 `44100` 或 `48000` |
| `channels` | `number` | WASAPI 播放设备原始通道数；进入 DSP 前会下混为单声道 |
| `capturedFrames` | `number` | 本次监听启动以来累计读取的音频帧数 |
| `droppedSamples` | `number` | RingBuffer 空间不足时未写入的单声道样本数 |
| `sequence` | `number` | DSP 分析快照递增序号；事件限流时允许跳号，不允许倒退 |
| `capturedAtUs` | `number` | 当前快照末尾在已处理 PCM 时间线中的微秒位置 |
| `rms` | `number` | 2048 点窗口的线性 RMS，范围 `[0, 1]` |
| `bass` | `number` | `0–250 Hz` 占当前窗口非直流频谱总能量的比例 |
| `mid` | `number` | `250–4000 Hz` 占当前窗口非直流频谱总能量的比例 |
| `treble` | `number` | `4000 Hz–Nyquist` 占当前窗口非直流频谱总能量的比例 |
| `onset` | `number` | 基于正向 spectral flux 的瞬态强度，范围 `[0, 1]` |
| `centroid` | `number` | Spectral centroid 除以 Nyquist 后的归一化值，范围 `[0, 1]` |
| `energyTrend` | `number` | 当前 RMS 相对上一窗口的变化方向和幅度，范围 `[-1, 1]` |
| `silence` | `boolean` | RMS 是否低于当前固定阈值 `0.001` |
| `microphoneEnabled` | `boolean` | 麦克风当前是否参与混音 |
| `microphoneLevel` | `number` | 麦克风 2048 点窗口的线性 RMS，范围 `[0, 1]`；用于观察环境电平 |
| `microphoneGate` | `number` | 当前生效的底噪门限；自动校准模式下为校准结果，手动模式下为设定值 |
| `microphoneGain` | `number` | 当前平滑后的门限增益，`1` 表示全量通过，靠近 `0.15` 表示被压到最低增益 |

系统音频与麦克风在 DSP 线程前合流，因此过滤后的缓冲会同时进入快速特征与 AI PCM 窗口。

`bass + mid + treble` 在非静音窗口中约等于 `1`。这些值表示频谱构成，不表示三个频段各自的绝对音量；前端应结合 `rms` 使用。所有特征当前未经设备响度标定，进入滤镜前仍需 Attack/Release、限幅和静音回落。

AI PCM 状态字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | `boolean` | 当前是否向 AI RingBuffer 复制 PCM 并发送窗口 |
| `outputSampleRateHz` | `number` | AI PCM 输出采样率；会话存在时固定为 `16000` |
| `windowSamples` | `number` | 每个窗口的样本数；会话存在时固定为 `48000` |
| `hopSamples` | `number` | 相邻窗口的步长；会话存在时固定为 `16000` |
| `streamEpoch` | `number` | 流连续性代次；启用、禁用、丢样或 Channel 失败时递增 |
| `sequence` | `number` | 当前启用周期内生成的窗口序号；每次启用时从零重新计数 |
| `emittedWindows` | `number` | 本次音频监听会话中成功发送的窗口累计数 |
| `droppedInputSamples` | `number` | 采集或 AI RingBuffer 丢失的输入采样累计数 |
| `bufferedInputSamples` | `number` | AI RingBuffer 中等待处理的设备采样率单声道样本数 |
| `lastError` | `string \| null` | 最近一次重采样或 Channel 发送错误 |

## 3. 快速 DSP 事件

### Event

```text
audio-features
```

### Payload

`AudioFeatures`

后端使用 2048 点 Hann 窗和 512 样本 hop 分析音频，并将事件限制在最高 60 Hz。44.1 kHz 和 48 kHz 设备上的典型事件频率约为 43–47 Hz。

### 订阅示例

```ts
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<AudioFeatures>("audio-features", ({ payload }) => {
  if (payload.silence) {
    return;
  }

  updateFilterFromAudio(payload);
});

// React effect cleanup 或页面销毁时调用
unlisten();
```

契约说明：

- 事件只在监听运行且 DSP 已积累一个完整窗口后产生。
- `sequence` 对每次 DSP 分析递增；由于 60 Hz 限流，前端看到跳号属于正常情况。
- 前端收到小于等于当前序号的数据时应丢弃。
- `capturedAtUs` 是音频流相对时间，不是 Unix 时间戳。
- 前端切换页面或组件卸载时必须调用 `unlisten`，避免重复订阅。
- Event 发送失败不会停止 WASAPI 或 DSP 线程。

## 4. DSP 性能

### Event

```text
audio-performance
```

### Command

```text
audio_performance_status
```

事件 Payload 和 Command 返回值均为 `DspPerformance`。事件约每秒发送一次；Command 无参数，适合页面初始化和按需查询。

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const initial = await invoke<DspPerformance>("audio_performance_status");
const unlisten = await listen<DspPerformance>("audio-performance", ({ payload }) => {
  updatePerformancePanel(payload);
});
```

| 字段 | 单位 | 说明 |
| --- | --- | --- |
| `sampleCount` | 次 | 本次监听会话累计完成的 DSP 分析次数 |
| `windowMs` | ms | 当前百分位窗口覆盖的近似音频时长，最多约 5–6 秒 |
| `lastUs` | μs | 最近一次纯 DSP 分析耗时 |
| `p50Us` | μs | 固定窗口内纯 DSP 分析耗时 P50 |
| `p95Us` | μs | 固定窗口内纯 DSP 分析耗时 P95 |
| `p99Us` | μs | 固定窗口内纯 DSP 分析耗时 P99 |
| `maxUs` | μs | 固定窗口内纯 DSP 分析最大耗时 |
| `pipelineLagUs` | μs | 本次读取后仍留在采集 RingBuffer 中的 PCM 对应时长 |
| `deadlineMisses` | 次 | 纯 DSP 耗时超过一个 512 样本 hop 时长的累计次数 |

计时范围只包含 Hann 窗、FFT 和特征计算，不包含 Tauri Event 发送。统计在 DSP 线程内使用固定容量数组记录，每秒最多排序一次，不在热路径分配统计缓冲。

`pipelineLagUs` 用于观察前端 AI 或系统高负载造成的调度压力。它不包含 WebView 渲染延迟，也不是声音到画面的端到端延迟。

监听未运行或首个性能窗口尚未生成时，`audio_performance_status` 返回全零对象。停止监听后该 Command 也返回全零对象。

## 5. 启动监听

### Command

```text
start_audio_monitor
```

### 参数

无。

### 返回

`Promise<AudioStatus>`

### 示例

```ts
import { invoke } from "@tauri-apps/api/core";

const status = await invoke<AudioStatus>("start_audio_monitor");
console.log("audio started", status);
```

行为说明：

- 首次调用会创建播放设备和麦克风 WASAPI 采集线程、DSP 线程和 AI PCM 线程，并等待设备初始化完成。麦克风失败时退回播放音频。AI PCM 默认禁用，线程仅低频休眠，不复制 PCM 或分配 3 秒滑窗。
- 如果监听已经运行，则不会重复创建线程，直接返回当前状态。
- 如果上一次会话已进入 `failed`，调用本接口会先回收旧线程，再重新获取当前默认输出设备并创建新会话。
- 启动失败时 Promise 被拒绝，错误值为后端返回的字符串。
- Debug 构建当前会在 Tauri 启动时自动调用监听；Release 构建需要前端显式调用本接口。

## 6. 查询状态

### Command

```text
audio_monitor_status
```

### 参数

无。

### 返回

`Promise<AudioStatus>`

### 示例

```ts
import { invoke } from "@tauri-apps/api/core";

const status = await invoke<AudioStatus>("audio_monitor_status");
console.log({
  running: status.running,
  rms: status.rms,
  droppedSamples: status.droppedSamples,
});
```

如监听未运行，返回全零默认状态：

```ts
{
  running: false,
  state: "stopped",
  lastError: null,
  sampleRateHz: 0,
  channels: 0,
  capturedFrames: 0,
  droppedSamples: 0,
  sequence: 0,
  capturedAtUs: 0,
  rms: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  onset: 0,
  centroid: 0,
  energyTrend: 0,
  silence: false,
  microphoneEnabled: true,
  microphoneLevel: 0,
  microphoneGate: 0.008,
  microphoneGain: 0,
}
```

状态面板建议每 `500–1000 ms` 查询一次。不要以逐帧或 60 Hz 频率轮询该接口；滤镜应订阅 `audio-features` Event。

运行期间如果输出设备被拔出、驱动失效或 WASAPI 读取失败：

- `state` 变为 `failed`，`running` 变为 `false`。
- `lastError` 提供后端错误说明。
- 快速特征和性能事件停止发送。
- 前端可以再次调用 `start_audio_monitor` 手动重建监听；当前版本不会自动重连。

## 7. 停止监听

### Command

```text
stop_audio_monitor
```

### 参数

无。

### 返回

`Promise<AudioStatus>`

### 示例

```ts
import { invoke } from "@tauri-apps/api/core";

const finalStatus = await invoke<AudioStatus>("stop_audio_monitor");
console.log("audio stopped", finalStatus);
```

行为说明：

- 停止播放设备和麦克风 WASAPI 采集线程、DSP 线程和 AI PCM 线程，并等待线程退出。
- 返回停止后的最终统计，其中 `running` 为 `false`。
- 如果监听尚未运行，返回全零默认状态。
- 再次调用 `start_audio_monitor` 会创建新的监听会话，累计计数从零开始。

## 8. 麦克风底噪控制

麦克风在 DSP 线程内与系统音频合流，前端无法在 JS 侧绕过门限，因此提供下列 Command 实时调整。参数在采集线程与 DSP 线程间通过原子量交换，下一个 DSP 窗口即可生效，无需重启监听。

### Command

```text
set_microphone_settings
```

### 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | `boolean` | 是否让麦克风参与混音；`false` 时只保留系统音频 |
| `gate` | `number` | 底噪门限，`0` 表示自动校准；有效范围 `[0, 0.2]`，超出会被后端截断 |
| `gain` | `number` | 麦克风增益，范围 `[0, 1]` |
| `recalibrate` | `boolean` | 置为 `true` 时重新开始约 2 秒的底噪校准（此期间请保持安静） |

### 返回

`Promise<AudioStatus>`

### 示例

```ts
import { invoke } from "@tauri-apps/api/core";

// 手动把门限抬到 0.03，常用做法是比环境电平高约 2 倍
await invoke<AudioStatus>("set_microphone_settings", {
  enabled: true,
  gate: 0.03,
  gain: 1,
  recalibrate: false,
});

// 重新自动校准
await invoke<AudioStatus>("set_microphone_settings", {
  enabled: true,
  gate: 0,
  gain: 1,
  recalibrate: true,
});
```

行为说明：

- 自动校准模式：启动后约 2 秒内保持最低增益 `0.15`，随后把该段环境 RMS 的 2.5 倍限制在 `[0.008, 0.2]` 作为门限。
- 门限生效后，低于门限的声音不会静音，而是平滑压到最低增益，避免房间底噪、键盘声和远处环境音盖住音乐。
- 设置值保存在应用进程内：停止后重新启动音频监听会沿用最近一次的门限与增益；应用重启后恢复为自动校准、增益 `1`。
- 监听未运行时调用会返回全零默认状态，但设置值仍会被记住，下次启动生效。

## 9. AI PCM Channel

AI PCM 链路要求音频监听已经处于 `running`。它将合流后的单声道 PCM 重采样为 16 kHz，并发送固定 3 秒窗口；相邻窗口步长为 1 秒。

### Commands

```text
start_ai_pcm_stream
stop_ai_pcm_stream
ai_pcm_status
```

`start_ai_pcm_stream` 接收名为 `channel` 的 Tauri `Channel<ArrayBuffer>`。再次调用会替换旧 Channel，并开始一个新的 `streamEpoch`。`stop_ai_pcm_stream` 禁用 AI 数据复制、清空重采样状态并释放 Channel。`ai_pcm_status` 无参数。

三个 Command 均返回 `Promise<AiPcmStatus>`。音频监听未运行时，`start_ai_pcm_stream` 会拒绝 Promise；其余两个状态接口在监听未运行时返回全零默认对象。

```ts
import { Channel, invoke } from "@tauri-apps/api/core";

const channel = new Channel<ArrayBuffer>();
channel.onmessage = (payload) => {
  if (payload.byteLength < 32) {
    return;
  }

  const view = new DataView(payload);
  const version = view.getUint32(0, true);
  const sampleRateHz = view.getUint32(4, true);
  const sampleCount = view.getUint32(8, true);
  if (version !== 1 || payload.byteLength !== 32 + sampleCount * 4) {
    return;
  }

  const streamEpoch = view.getBigUint64(16, true);
  const sequence = view.getBigUint64(24, true);
  const samples = new Float32Array(payload, 32, sampleCount);

  enqueueLatestForAudioWorker({
    version,
    sampleRateHz,
    streamEpoch,
    sequence,
    samples,
  });
};

const status = await invoke<AiPcmStatus>("start_ai_pcm_stream", { channel });
```

二进制 Payload 全部使用小端序：

| 偏移 | 长度 | 类型 | 内容 |
| ---: | ---: | --- | --- |
| 0 | 4 | `u32` | 协议版本，当前为 `1` |
| 4 | 4 | `u32` | 采样率，固定为 `16000` |
| 8 | 4 | `u32` | 样本数，固定为 `48000` |
| 12 | 4 | `u32` | 保留字段，当前为 `0` |
| 16 | 8 | `u64` | `streamEpoch` |
| 24 | 8 | `u64` | 窗口 `sequence` |
| 32 | 192000 | `f32[48000]` | 单声道 PCM |

当采集 RingBuffer 或 AI RingBuffer 发生丢样时，Rust 会递增 `streamEpoch`，清空 AI RingBuffer，并重置重采样器和滑窗。前端不得跨 epoch 拼接或比较窗口序号。

Tauri Channel 不提供模型消费确认。Channel 回调向 Web Worker 投递时，适配层必须采用单槽 latest-only 策略：模型忙时覆盖尚未开始推理的旧窗口，不建立无界队列。该 latest-only 行为由前端实现，Rust 端不会等待模型推理。Channel 发送失败时 AI PCM 自动禁用，错误写入 `lastError`；快速 DSP 和 WASAPI 监听继续运行。

## 10. 推荐封装

```ts
import { Channel, invoke } from "@tauri-apps/api/core";

export const audioMonitorApi = {
  start: () => invoke<AudioStatus>("start_audio_monitor"),
  status: () => invoke<AudioStatus>("audio_monitor_status"),
  performance: () => invoke<DspPerformance>("audio_performance_status"),
  stop: () => invoke<AudioStatus>("stop_audio_monitor"),
  setMicrophone: (settings: { enabled: boolean; gate: number; gain: number; recalibrate?: boolean }) =>
    invoke<AudioStatus>("set_microphone_settings", { recalibrate: false, ...settings }),
  startAiPcm: (channel: Channel<ArrayBuffer>) =>
    invoke<AiPcmStatus>("start_ai_pcm_stream", { channel }),
  stopAiPcm: () => invoke<AiPcmStatus>("stop_ai_pcm_stream"),
  aiPcmStatus: () => invoke<AiPcmStatus>("ai_pcm_status"),
};
```

调用时应捕获 Promise 错误：

```ts
try {
  const status = await audioMonitorApi.start();
  console.log(status);
} catch (error) {
  console.error("Failed to start audio monitor", String(error));
}
```

## 11. 当前边界

当前版本仅提供：

- 默认 Windows 播放设备的 WASAPI Loopback 与默认麦克风采集；麦克风失败时回退到仅播放音频。
- 麦克风底噪门限与增益的运行时调整（含手动设置与重新自动校准）。
- PCM 累计帧数和丢样统计。
- RMS、Bass、Mid、Treble、Onset、Spectral Centroid、能量趋势和静音状态。
- 最高 60 Hz 的 `audio-features` 主动事件。
- 约每秒一次的 `audio-performance` 性能事件和按需状态查询。
- 16 kHz 单声道 `f32` AI PCM 二进制窗口，固定 3 秒窗口和 1 秒步长。
- AI PCM 启停、状态查询、断流 `streamEpoch` 和 Channel 失败降级。

当前尚未提供：

- 音频设备选择。
- 设备相关响度标定和运行时自适应噪声底；当前仅在启动后的前 2 秒校准麦克风底噪。
- 默认输出设备变化通知和自动重连；设备失效后需要前端重新调用 `start_audio_monitor`。
- 前端模型推理、Web Worker 队列和 latest-only 调度。

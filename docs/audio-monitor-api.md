# Audio Monitor 前端 API

## 1. 概述

Rust 后端通过 Tauri Command 提供系统音频监听的启动、停止和状态查询接口，并通过 Tauri Event 主动推送快速 DSP 特征。

- Command 用于生命周期控制和低频状态面板。
- `audio-features` Event 用于 30–60 Hz 动态滤镜驱动。
- 前端不接收原始 PCM，不应通过高频轮询驱动滤镜。

## 2. 前端类型

```ts
export interface AudioStatus {
  running: boolean;
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
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `running` | `boolean` | 音频监听是否处于运行状态 |
| `sampleRateHz` | `number` | WASAPI 输出设备采样率，例如 `44100` 或 `48000` |
| `channels` | `number` | WASAPI 输出设备原始通道数；进入 DSP 前会下混为单声道 |
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

`bass + mid + treble` 在非静音窗口中约等于 `1`。这些值表示频谱构成，不表示三个频段各自的绝对音量；前端应结合 `rms` 使用。所有特征当前未经设备响度标定，进入滤镜前仍需 Attack/Release、限幅和静音回落。

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

## 4. 启动监听

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

- 首次调用会创建 WASAPI 采集线程和 DSP 线程，并等待设备初始化完成。
- 如果监听已经运行，则不会重复创建线程，直接返回当前状态。
- 启动失败时 Promise 被拒绝，错误值为后端返回的字符串。
- Debug 构建当前会在 Tauri 启动时自动调用监听；Release 构建需要前端显式调用本接口。

## 5. 查询状态

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
}
```

状态面板建议每 `500–1000 ms` 查询一次。不要以逐帧或 60 Hz 频率轮询该接口；滤镜应订阅 `audio-features` Event。

## 6. 停止监听

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

- 停止 WASAPI 采集线程和 DSP 线程，并等待两个线程退出。
- 返回停止后的最终统计，其中 `running` 为 `false`。
- 如果监听尚未运行，返回全零默认状态。
- 再次调用 `start_audio_monitor` 会创建新的监听会话，累计计数从零开始。

## 7. 推荐封装

```ts
import { invoke } from "@tauri-apps/api/core";

export interface AudioStatus {
  running: boolean;
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
}

export const audioMonitorApi = {
  start: () => invoke<AudioStatus>("start_audio_monitor"),
  status: () => invoke<AudioStatus>("audio_monitor_status"),
  stop: () => invoke<AudioStatus>("stop_audio_monitor"),
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

## 8. 当前边界

当前版本仅提供：

- 默认 Windows 输出设备的 WASAPI Loopback 监听。
- PCM 累计帧数和丢样统计。
- RMS、Bass、Mid、Treble、Onset、Spectral Centroid、能量趋势和静音状态。
- 最高 60 Hz 的 `audio-features` 主动事件。

当前尚未提供：

- 音频设备选择。
- 设备相关响度标定和自适应噪声底。
- AI 使用的 16 kHz PCM 二进制窗口。

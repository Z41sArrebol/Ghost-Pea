# Audio Monitor 前端 API

## 1. 概述

Rust 后端通过 Tauri Command 提供系统音频监听的启动、停止和状态查询接口。

当前接口属于状态查询 API，不会主动向前端推送事件。前端如需更新状态，应进行低频轮询；实时音频特征后续将使用独立的 Tauri Event 接口。

## 2. 前端类型

```ts
export interface AudioStatus {
  running: boolean;
  sampleRateHz: number;
  channels: number;
  capturedFrames: number;
  droppedSamples: number;
  rms: number;
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
| `rms` | `number` | DSP 最近一次处理块的线性 RMS，通常位于 `0.0` 至 `1.0` |

注意：`rms` 当前未经响度标定或动态归一化，不应直接作为最终滤镜参数。

## 3. 启动监听

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

## 4. 查询状态

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
  rms: 0,
}
```

状态面板建议每 `500–1000 ms` 查询一次。不要以逐帧或 60 Hz 频率轮询该接口；滤镜需要的实时特征应等待 Tauri Event 接口。

## 5. 停止监听

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

## 6. 推荐封装

```ts
import { invoke } from "@tauri-apps/api/core";

export interface AudioStatus {
  running: boolean;
  sampleRateHz: number;
  channels: number;
  capturedFrames: number;
  droppedSamples: number;
  rms: number;
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

## 7. 当前边界

当前版本仅提供：

- 默认 Windows 输出设备的 WASAPI Loopback 监听。
- PCM 累计帧数和丢样统计。
- 最近一个 DSP 数据块的 RMS。

当前尚未提供：

- 音频设备选择。
- Bass、Mid、Treble、Onset 和 Spectral Centroid。
- 30–60 Hz 主动特征事件。
- AI 使用的 16 kHz PCM 二进制窗口。

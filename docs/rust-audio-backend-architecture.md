# Ghost Pea Rust 音频后端架构

## 1. 文档范围

本文描述 Ghost Pea 的 Rust 音频后端实现，包括 WASAPI Loopback 采集、快速 DSP、AI PCM 窗口生产、Tauri 通信和运行状态管理。

本文是 Rust 模块内部设计，不修改团队公共架构的产品边界。公共约束以 `ghost-pea-technical-architecture.md` 为准。

## 2. 设计目标

- 音频采集回调不执行阻塞操作或高开销计算。
- 快速 DSP 不受 AI 推理和大块 IPC 传输影响。
- 所有跨线程队列有界，消费者落后时不形成无限内存增长。
- AI 禁用时不复制 PCM，也不分配 3 秒窗口；常驻 AI 线程只休眠并清空缓冲。
- P2 可以在不改变采集和快速 DSP 接口的情况下启用 AI PCM 链路。
- Release 构建中，快速 DSP 周期耗时目标为 P95 小于 3 ms、P99 小于 5 ms。

## 3. 执行上下文

### 3.1 P0：两个执行上下文

```text
WASAPI Loopback 回调
  → 格式转换与单声道下混
  → PCM SPSC 环形缓冲
                 ↓
          快速 DSP 线程
          ├─ RMS / Bass / Mid / Treble
          ├─ Onset / Spectral Centroid
          └─ 最高 60 Hz Tauri Event
```

这里的两个执行上下文仅指 Rust 音频链，不包含 Tauri 自身的运行时线程和前端线程。

### 3.2 P2：第三个专用线程

```text
WASAPI Loopback 回调
  → PCM SPSC 环形缓冲
                 ↓
          快速 DSP 线程
          ├─ 快速特征 → Tauri Event
          └─ 非阻塞复制 → AI SPSC 环形缓冲
                                ↓
                         AI PCM 生产线程
                         ├─ 44.1/48 kHz → 16 kHz 重采样
                         ├─ 维护 3 秒滑动窗口
                         └─ 1 Hz 二进制 Channel
```

AI PCM 生产线程随音频会话启动，AI 禁用时不消费或分配滑窗，只进行低频休眠。它不执行模型推理；模型推理属于前端 Web Worker。

快速 DSP 向 AI 缓冲写入时不得等待。AI 缓冲空间不足时丢弃当前 DSP 块并递增 `streamEpoch`。AI 线程观察到 epoch 变化后清空积压、重置重采样器和滑动窗口，避免把时间上不连续的样本拼接成一个有效窗口。

## 4. 线程职责

### 4.1 WASAPI 回调

允许执行：

1. 读取 WASAPI Loopback 数据。
2. 将设备样本格式转换为 `f32`。
3. 将多声道数据下混为单声道。
4. 将样本写入预分配的有界 SPSC 环形缓冲。
5. 通过原子计数器记录丢弃的样本数。

禁止执行：

- FFT、重采样和 AI 推理。
- Tauri Event 或 Channel 发送。
- 日志、文件写入和动态扩容。
- 阻塞锁、等待消费者或休眠。

### 4.2 快速 DSP 线程

快速 DSP 线程持续消费单声道 `f32` PCM，并以 60 至 100 Hz 更新分析状态：

- RMS 和归一化能量。
- Bass、Mid、Treble 能量。
- Onset。
- Spectral centroid。
- 能量变化方向和静音状态。

线程复用预分配的窗函数、FFT 输入、FFT 输出和历史状态。控制快照最高以 60 Hz 发送，并携带递增序号和单调时间戳。

P2 启用后，DSP 线程将刚消费的 PCM 非阻塞地复制到 AI 专用缓冲。AI 缓冲溢出只影响 AI 输出，不得影响快速特征计算和发送。

### 4.3 AI PCM 生产线程

该线程仅负责：

1. 消费 AI 专用 PCM 缓冲。
2. 重采样为 16 kHz 单声道 `f32`。
3. 维护固定 3 秒、1 秒步长的滑动窗口。
4. 通过二进制 Tauri Channel 发布完整窗口。
5. 统计发送窗口、输入丢样、缓冲深度和 `streamEpoch`。

AI PCM 使用二进制 Channel 传输，不使用 JSON 数组。发送失败时禁用 AI PCM，但不停止快速 DSP。前端 Channel 到 Web Worker 的适配层负责只保留最新待推理窗口。

## 5. 初步类型设计

以下类型用于明确边界，字段可在实现阶段按 crate API 调整：

```rust
type MonoSample = f32;

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFeatures {
    pub sequence: u64,
    pub captured_at_us: u64,
    pub rms: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub onset: f32,
    pub centroid: f32,
    pub energy_trend: f32,
    pub silence: bool,
}

pub struct AiPcmStatus {
    pub enabled: bool,
    pub output_sample_rate_hz: u32,
    pub window_samples: u32,
    pub hop_samples: u32,
    pub stream_epoch: u64,
    pub sequence: u64,
    pub emitted_windows: u64,
    pub dropped_input_samples: u64,
    pub buffered_input_samples: u64,
    pub last_error: Option<String>,
}

pub struct AudioRuntimeStats {
    pub capture_dropped_samples: u64,
    pub ai_dropped_samples: u64,
    pub dsp_last_us: u32,
    pub dsp_max_us: u32,
    pub ai_send_last_us: u32,
}
```

约定：

- PCM 内部统一使用单声道 `f32`，标称范围为 `[-1.0, 1.0]`。
- 连续控制特征发送前归一化到 `[0.0, 1.0]`，`energy_trend` 使用 `[-1.0, 1.0]`。
- `captured_at_us` 表示音频流启动后的单调微秒数，不使用系统墙上时间。
- `sequence` 在同类消息内严格递增。
- `Instant`、FFT 对象、重采样器和环形缓冲端点不跨 IPC 序列化。
- AI PCM 的 Rust 所有权类型与最终 Tauri 二进制载荷类型分离，避免误用 JSON 序列化。

## 6. 队列与过载策略

| 队列 | 生产者 | 消费者 | 满载策略 |
| --- | --- | --- | --- |
| 采集 PCM 缓冲 | WASAPI 回调 | DSP 线程 | 不阻塞回调，丢弃当前无法写入的样本并计数 |
| AI PCM 缓冲 | DSP 线程 | AI PCM 生产线程 | 不阻塞 DSP，整块丢弃当前输入并推进 epoch |
| AI Channel 接收槽 | Tauri Channel 回调 | 前端 Web Worker | 前端只保留最新待推理窗口 |

缓冲容量以时间而不是固定样本数配置，并根据设备采样率换算。初始建议：

- 采集 PCM 缓冲覆盖 100 至 250 ms。
- AI PCM 缓冲覆盖 500 至 1000 ms。
- AI 完整窗口最多保留一个待发送实例。

任何丢弃都必须进入运行统计，但统计更新不能阻塞实时线程。

## 7. 生命周期

```text
Stopped → Starting → Running → Stopping → Stopped
                     └───────→ Failed
```

启动顺序：

1. 读取并确认 WASAPI Mix Format。
2. 分配所有实时缓冲和 DSP 工作区。
3. 启动 DSP 线程。
4. 启动 WASAPI Loopback。
5. 启动 AI PCM 生产线程；禁用状态下线程休眠且 DSP 不复制数据。
6. 发布 `Running` 状态。

停止顺序与启动顺序相反。停止信号使用原子状态或非阻塞控制通道；退出时可以在非实时控制路径等待线程 `join`。启动和停止通过独立生命周期互斥锁串行执行，Tauri Command 将这些阻塞操作提交到 blocking worker，禁止在 WebView2 协议处理线程直接等待音频线程退出。

WASAPI 共享模式的 `get_next_packet_size` 在没有可读数据时返回 `Some(0)`。采集线程只在帧数大于零且停止标志未设置时读取数据；每次排空设备包前都重新检查停止标志，保证静音设备也能及时退出。

设备断开或采集失败时停止产生正常特征快照，发布明确错误状态，并清空旧 PCM，避免重连后消费过期数据。

P0 采用可靠失败和手动重启策略：运行期 WASAPI 读取错误或健康检查失败时，共享状态切换为 `Failed`，记录 `last_error` 并停止 DSP。下一次启动请求先回收失败会话的线程和缓冲，再基于当前默认输出设备创建全新会话。默认设备变化的主动通知和自动重连留到 P1。

## 8. 性能预算与验收

容量估算采用 48 kHz 双声道输入、回调内下混、100 Hz DSP 更新和 2048 点 FFT：

| 工作 | 每 10 ms 周期的保守耗时 |
| --- | ---: |
| 格式转换、下混和 RMS | 小于 0.1 ms |
| 2048 点 FFT 与频段聚合 | 0.05–0.6 ms |
| Onset、Centroid 和状态更新 | 小于 0.2 ms |
| 特征事件发送 | 0.05–0.3 ms |
| P2：复制到 AI 缓冲 | 小于 0.1 ms |

该估算只用于确定线程模型，最终以目标演示设备上的 Release 构建为准。

验收项目：

- 连续运行 10 分钟无崩溃和无界内存增长。
- DSP 周期耗时 P95 小于 3 ms、P99 小于 5 ms。
- 正常负载下采集缓冲无溢出。
- 人工延迟 AI 消费者时，快速 DSP 的 P99 不明显上升。
- AI 禁用时不复制 PCM、不运行重采样，也不分配 3 秒窗口。
- 音频设备断开后不再发送伪正常快照。

### 8.1 DSP 性能观测

DSP 在每次快速特征分析前后读取单调时钟，将耗时写入固定容量的 512 项窗口。热路径不加锁、不输出日志，也不分配统计缓冲。每秒在 DSP 线程中生成一次 P50、P95、P99 和最大值快照。

性能接口同时报告采集 RingBuffer 剩余 PCM 对应的 `pipeline_lag_us`。该值用于区分算法计算变慢与线程调度、IPC 或系统负载导致的消费积压。

性能快照通过 `audio-performance` Tauri Event 约每秒发送一次，并可通过 `audio_performance_status` Command 按需查询。性能数据不混入高频 `audio-features` 事件。

## 9. 实施顺序

1. 定义音频配置、特征快照、运行状态和统计类型。
2. 完成 WASAPI Loopback 到采集 PCM 缓冲。
3. 完成 DSP 线程及固定输入回放测试。
4. 接入 Tauri 特征事件及 DSP 性能 P50、P95、P99 测量。
5. 为 P2 增加 AI PCM 缓冲和独立线程。
6. 接入二进制 Channel、断流 epoch 和窗口测试。
7. 在前端 Web Worker 适配层验证消费者延迟和 latest-only 策略。

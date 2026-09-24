# Ghost-Pea「共振镜头」

让镜头听见此刻。

一个 Windows 桌面小工具：实时采集系统声音，驱动相机滤镜在拍摄过程中连续变化——不是拍完再后期，也不是音频可视化，声音直接控制色彩、影调、Bloom、颗粒等成像参数，处理后的画面交给 OBS 直播或录制。

## 特性

- **实时声画联动** — WASAPI 系统音频回环 → 快速 DSP（RMS / Bass / Mid / Treble / Onset / Centroid）→ 30–60 Hz 参数事件直达渲染链，声音到画面 P50 < 80 ms
- **成像参数，不是可视化** — 不画波形和频谱，声音驱动的是 Bloom、Halation、颗粒、局部对比度
- **Live / Memory 双模式** — 直播实时预览 + OBS Virtual Camera 输出；一键录制 10–30 s 氛围片段
- **三套视觉主题** — Calm / Dream、Bright / Alive、Dark / Tension
- **安全约束内置** — 肤色保护、频闪保护、曝光保护、静音回落，所有参数变化由编排器统一收口
- **AI 可选增强** — Web Worker 中运行的氛围状态推断（Essentia.js + TF.js），超时或失败时基础链路照常工作
- **不自研驱动** — 录制、直播、虚拟摄像头全部交给 OBS

## 工作原理

```text
Windows 系统音频 ──WASAPI Loopback──▶ Rust 音频后端（快速 DSP / 重采样）
                                          │ 30–60 Hz 参数事件
                                          ▼
UVC 相机 ──getUserMedia──▶ PixiJS Video Texture ──WebGL2 Shader──▶ Tauri 窗口
                                                                        │
                                          OBS Window Capture ◀──────────┘
                                          （录制 / 直播 / 虚拟摄像头）
```

视频帧始终留在前端 GPU 链路，不经过 Tauri IPC；慢速 AI（0.5–2 Hz）只决定氛围状态，不进低延迟关键链路。

## 快速开始

环境要求：Windows 10/11、Node.js ≥ 20、pnpm 12、Rust stable（MSVC 工具链）、OBS Studio（输出用）。

```bash
pnpm install
pnpm tauri dev
```

启动后选择音频来源、USB 相机和滤镜主题即可预览；OBS 中通过 Window Capture 采集本工具窗口，或直接启用 OBS Virtual Camera。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 仅启动前端开发服务器 |
| `pnpm tauri dev` | 启动完整桌面应用（前端 + Rust 后端） |
| `pnpm build` | 前端生产构建 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm typecheck` | TypeScript 类型检查 |

## 项目结构

```text
src/            前端：React UI、PixiJS/WebGL2 滤镜链、参数编排器
src-tauri/      Rust 音频后端：WASAPI 采集、快速 DSP、重采样、事件通道
packages/       workspace 包（audio-ai：可选的氛围状态推断）
docs/           架构与接口文档
pitch/          路演与提案材料
```

## 技术栈

- **桌面容器**：Tauri 2 + Rust stable + TypeScript + Vite + React 18
- **音频后端**：`wasapi`（系统音频回环）、`ringbuf`、`realfft`、`rubato`
- **渲染**：PixiJS 滤镜链 + WebGL2 自定义 Fragment Shader，`requestVideoFrameCallback()` 跟随帧更新
- **AI（可选）**：Essentia.js + TensorFlow.js，运行于 Web Worker

## 文档

- [总体技术架构](docs/ghost-pea-technical-architecture.md)
- [Rust 音频后端架构](docs/rust-audio-backend-architecture.md)
- [音频监听接口](docs/audio-monitor-api.md)
- [audio-ai 包架构](docs/audio-ai-package-architecture.md)

## 团队

| 成员 | 负责 |
|---|---|
| 李佳玥 | Rust 音频后端：WASAPI 采集、快速 DSP、重采样、Tauri 事件/通道 |
| 张智瑞 | 前端渲染与 UI：滤镜链、视觉主题、参数编排器、Live/Memory Mode、OBS 联调 |

> 影石「白日方舟」黑客松赛道一作品（2026.09，南京），组队提案书见 [pitch/](pitch/Ghost-Pea-共振镜头-组队提案书.md)。

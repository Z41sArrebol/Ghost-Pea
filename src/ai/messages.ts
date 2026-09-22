// 主线程 ↔ AI Worker 的消息协议。
// 输入对齐架构契约 5.2（16 kHz 单声道 Float32 PCM，2~5 秒，二进制传输），
// 输出对齐契约 5.3（情绪概率 + 置信度 + 推理耗时 + 模型就绪）。

export interface PcmWindowMessage {
  type: "pcm";
  // Float32 PCM 的底层 buffer，发送时用 Transferable 转移所有权，零拷贝
  buffer: ArrayBuffer;
  sampleRate: 16000;
  capturedAtUs: number;
}

export interface SelfTestMessage {
  type: "self-test";
}

export interface PingMessage {
  type: "ping";
}

export type MainToWorker = PcmWindowMessage | SelfTestMessage | PingMessage;

export interface AiMood {
  happy: number;
  sad: number;
  relaxed: number;
  aggressive: number;
  confidence: number;
  inferenceMs: number;
  modelReady: boolean;
}

export interface MoodMessage {
  type: "mood";
  mood: AiMood;
}

export interface ReadyMessage {
  type: "ready";
  modelReady: boolean;
}

export interface WorkerErrorMessage {
  type: "error";
  message: string;
}

export type WorkerToMain = MoodMessage | ReadyMessage | WorkerErrorMessage;

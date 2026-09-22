import type { AiMood, MainToWorker, WorkerToMain } from "./messages";

// Worker 全局作用域。不引入 webworker lib 以避免与 tsconfig 的 DOM lib 冲突。
const ctx = self as unknown as {
  postMessage: (message: WorkerToMain, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
};

// TODO: 接入 Essentia.js + TF.js 后在这里异步加载模型，就绪后置 true。
const modelReady = false;

// 占位推理：模型接入前产出四等分、零置信度的结果。
// 置信度不足 → 上层按契约解析为 Neutral，不影响主题，快速链路照常。
function inferPlaceholderMood(pcm: Float32Array): AiMood {
  const start = performance.now();
  let squareSum = 0;
  for (let i = 0; i < pcm.length; i++) {
    squareSum += pcm[i] * pcm[i];
  }
  return {
    happy: 0.25,
    sad: 0.25,
    relaxed: 0.25,
    aggressive: 0.25,
    confidence: 0,
    inferenceMs: performance.now() - start,
    modelReady,
  };
}

function handlePcm(buffer: ArrayBuffer): void {
  const pcm = new Float32Array(buffer);
  ctx.postMessage({ type: "mood", mood: inferPlaceholderMood(pcm) });
}

function handleSelfTest(): void {
  // 3 秒 440 Hz 正弦波，只为走通"收 PCM → 回情绪"的协议
  const pcm = new Float32Array(16_000 * 3);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.sin((i / 16_000) * 440 * 2 * Math.PI) * 0.2;
  }
  ctx.postMessage({ type: "mood", mood: inferPlaceholderMood(pcm) });
}

ctx.onmessage = (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "ping":
        ctx.postMessage({ type: "ready", modelReady });
        break;
      case "pcm":
        handlePcm(message.buffer);
        break;
      case "self-test":
        handleSelfTest();
        break;
    }
  } catch (error) {
    ctx.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

export {};

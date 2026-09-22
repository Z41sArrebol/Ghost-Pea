import type { MoodResult } from "./contracts";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
  postMessage: (message: WorkerToMainMessage) => void;
  close: () => void;
};

let initialized = false;
let modelReady = false;

function inferPlaceholder(message: Extract<MainToWorkerMessage, { type: "pcm" }>): MoodResult {
  const startedAt = performance.now();
  const pcm = new Float32Array(message.payload);
  let squareSum = 0;
  for (const sample of pcm) squareSum += sample * sample;
  void squareSum;

  return {
    streamEpoch: message.streamEpoch,
    sequence: message.sequence,
    scores: {
      happy: 0.25,
      sad: 0.25,
      relaxed: 0.25,
      aggressive: 0.25,
    },
    confidence: 0,
    inferenceMs: performance.now() - startedAt,
    modelReady,
  };
}

workerScope.onmessage = (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "init":
        void message.modelBaseUrl;
        initialized = true;
        workerScope.postMessage({ type: "ready", modelReady });
        break;
      case "pcm":
        if (!initialized) throw new Error("AI worker is not initialized");
        workerScope.postMessage({ type: "result", result: inferPlaceholder(message) });
        break;
      case "dispose":
        workerScope.postMessage({ type: "disposed" });
        workerScope.close();
        break;
    }
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      fatal: false,
    });
  }
};

export {};
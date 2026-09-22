import type { MoodResult } from "./contracts";
import { MoodRuntime } from "./moodRuntime";
import { getDominanceConfidence, RollingMoodScores } from "./scoreAggregation";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
  postMessage: (message: WorkerToMainMessage) => void;
  close: () => void;
};

let initialized = false;
let modelReady = false;
const runtime = new MoodRuntime();
const scoreHistory = new RollingMoodScores();

async function infer(message: Extract<MainToWorkerMessage, { type: "pcm" }>): Promise<MoodResult> {
  const startedAt = performance.now();
  const pcm = new Float32Array(message.payload);
  const scores = scoreHistory.push(message.streamEpoch, await runtime.predict(pcm));

  return {
    streamEpoch: message.streamEpoch,
    sequence: message.sequence,
    scores,
    confidence: getDominanceConfidence(scores),
    inferenceMs: performance.now() - startedAt,
    modelReady,
  };
}

workerScope.onmessage = async (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "init":
        await runtime.initialize(message.modelBaseUrl);
        initialized = true;
        modelReady = true;
        workerScope.postMessage({ type: "ready", modelReady });
        break;
      case "pcm":
        if (!initialized) throw new Error("AI worker is not initialized");
        workerScope.postMessage({ type: "result", result: await infer(message) });
        break;
      case "dispose":
        scoreHistory.reset();
        runtime.dispose();
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
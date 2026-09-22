import { PCM_HEADER_BYTES, type MoodResult, type PcmWindow } from "./contracts";
import { LatestOnlyScheduler } from "./latestOnlyScheduler";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol";

const WORKER_READY_TIMEOUT_MS = 15_000;

export interface WorkerClientCallbacks {
  onResult: (result: MoodResult) => void;
  onError: (error: Error, fatal: boolean) => void;
}

export class WorkerClient {
  private worker: Worker | null = null;
  private readonly scheduler = new LatestOnlyScheduler((window) => this.dispatch(window));

  constructor(private readonly callbacks: WorkerClientCallbacks) {}

  async start(modelBaseUrl: string): Promise<boolean> {
    if (this.worker) throw new Error("AI worker is already started");

    const worker = new Worker(new URL("./mood.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;

    return new Promise<boolean>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.terminate();
        reject(new Error("AI worker initialization timed out"));
      }, WORKER_READY_TIMEOUT_MS);

      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        const error = new Error(event.message || "AI worker failed");
        this.callbacks.onError(error, true);
        this.terminate();
        reject(error);
      };

      worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
        const message = event.data;
        if (message.type === "ready") {
          window.clearTimeout(timeout);
          resolve(message.modelReady);
          return;
        }
        this.handleMessage(message);
      };

      worker.postMessage({ type: "init", modelBaseUrl } satisfies MainToWorkerMessage);
    });
  }

  enqueue(window: PcmWindow): void {
    if (!this.worker) throw new Error("AI worker is not started");
    this.scheduler.enqueue(window);
  }

  terminate(): void {
    this.scheduler.reset();
    this.worker?.terminate();
    this.worker = null;
  }

  private dispatch(window: PcmWindow): void {
    if (!this.worker) return;
    const pcm = window.payload.slice(PCM_HEADER_BYTES);
    const message: MainToWorkerMessage = {
      type: "pcm",
      streamEpoch: window.streamEpoch,
      sequence: window.sequence,
      sampleRateHz: window.sampleRateHz,
      sampleCount: window.sampleCount,
      payload: pcm,
    };
    this.worker.postMessage(message, [pcm]);
  }

  private handleMessage(message: WorkerToMainMessage): void {
    switch (message.type) {
      case "result":
        if (this.scheduler.complete(message.result.streamEpoch, message.result.sequence)) {
          this.callbacks.onResult(message.result);
        }
        break;
      case "error":
        this.scheduler.reset();
        this.callbacks.onError(new Error(message.message), message.fatal);
        break;
      case "disposed":
      case "ready":
        break;
    }
  }
}
import type { AudioMoodStatus, MoodResult } from "./contracts";
import { TauriPcmSource } from "./tauriPcmSource";
import { WorkerClient } from "./workerClient";

export interface AudioMoodServiceOptions {
  modelBaseUrl: string;
}

export interface AudioMoodService {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (result: MoodResult) => void): () => void;
  subscribeStatus(listener: (status: AudioMoodStatus) => void): () => void;
  getStatus(): AudioMoodStatus;
  dispose(): Promise<void>;
}

class DefaultAudioMoodService implements AudioMoodService {
  private readonly resultListeners = new Set<(result: MoodResult) => void>();
  private readonly statusListeners = new Set<(status: AudioMoodStatus) => void>();
  private readonly workerClient: WorkerClient;
  private readonly pcmSource: TauriPcmSource;
  private status: AudioMoodStatus = {
    phase: "idle",
    modelReady: false,
    backendConnected: false,
    lastError: null,
  };

  constructor(private readonly options: AudioMoodServiceOptions) {
    this.workerClient = new WorkerClient({
      onResult: (result) => {
        for (const listener of this.resultListeners) listener(result);
      },
      onError: (error, fatal) => {
        this.updateStatus({ phase: fatal ? "failed" : "degraded", lastError: error.message });
      },
    });
    this.pcmSource = new TauriPcmSource(
      (window) => this.workerClient.enqueue(window),
      (error) => this.updateStatus({ phase: "degraded", lastError: error.message }),
    );
  }

  async start(): Promise<void> {
    if (this.status.phase === "disposed") throw new Error("Audio mood service is disposed");
    if (this.status.phase === "running" || this.status.phase === "degraded") return;

    this.updateStatus({ phase: "loading", lastError: null });
    try {
      const modelReady = await this.workerClient.start(this.options.modelBaseUrl);
      const backendStatus = await this.pcmSource.start();
      this.updateStatus({
        phase: modelReady ? "running" : "degraded",
        modelReady,
        backendConnected: backendStatus.enabled,
        lastError: modelReady ? null : "AI models are not loaded; placeholder inference is active",
      });
    } catch (error) {
      this.workerClient.terminate();
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus({ phase: "failed", modelReady: false, backendConnected: false, lastError: message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.status.phase === "disposed" || this.status.phase === "idle") return;
    try {
      await this.pcmSource.stop();
    } finally {
      this.workerClient.terminate();
      this.updateStatus({ phase: "idle", modelReady: false, backendConnected: false, lastError: null });
    }
  }

  subscribe(listener: (result: MoodResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  subscribeStatus(listener: (status: AudioMoodStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): AudioMoodStatus {
    return this.status;
  }

  async dispose(): Promise<void> {
    if (this.status.phase === "disposed") return;
    await this.stop();
    this.resultListeners.clear();
    this.statusListeners.clear();
    this.status = { phase: "disposed", modelReady: false, backendConnected: false, lastError: null };
  }

  private updateStatus(patch: Partial<AudioMoodStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.statusListeners) listener(this.status);
  }
}

export function createTauriAudioMoodService(options: AudioMoodServiceOptions): AudioMoodService {
  return new DefaultAudioMoodService(options);
}
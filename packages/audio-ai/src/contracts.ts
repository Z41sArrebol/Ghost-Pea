export const PCM_PROTOCOL_VERSION = 1;
export const PCM_SAMPLE_RATE_HZ = 16_000;
export const PCM_WINDOW_SAMPLES = 48_000;
export const PCM_HEADER_BYTES = 32;

export type PcmChannelPayload = ArrayBuffer | Uint8Array | number[];

export interface PcmWindow {
  protocolVersion: number;
  sampleRateHz: number;
  sampleCount: number;
  streamEpoch: bigint;
  sequence: bigint;
  payload: ArrayBuffer;
}

export interface AiPcmStatus {
  enabled: boolean;
  outputSampleRateHz: number;
  windowSamples: number;
  hopSamples: number;
  streamEpoch: number;
  sequence: number;
  emittedWindows: number;
  droppedInputSamples: number;
  bufferedInputSamples: number;
  lastError: string | null;
}

export interface MoodScores {
  happy: number;
  sad: number;
  relaxed: number;
  aggressive: number;
}

export interface MoodResult {
  streamEpoch: bigint;
  sequence: bigint;
  scores: MoodScores;
  confidence: number;
  inferenceMs: number;
  modelReady: boolean;
}

export type AudioMoodPhase = "idle" | "loading" | "running" | "degraded" | "failed" | "disposed";

export interface AudioMoodStatus {
  phase: AudioMoodPhase;
  modelReady: boolean;
  backendConnected: boolean;
  lastError: string | null;
}
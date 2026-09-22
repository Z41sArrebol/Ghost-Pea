import type { MoodResult } from "./contracts";

export interface WorkerInitMessage {
  type: "init";
  modelBaseUrl: string;
}

export interface WorkerPcmMessage {
  type: "pcm";
  streamEpoch: bigint;
  sequence: bigint;
  sampleRateHz: number;
  sampleCount: number;
  payload: ArrayBuffer;
}

export interface WorkerDisposeMessage {
  type: "dispose";
}

export type MainToWorkerMessage = WorkerInitMessage | WorkerPcmMessage | WorkerDisposeMessage;

export interface WorkerReadyMessage {
  type: "ready";
  modelReady: boolean;
}

export interface WorkerResultMessage {
  type: "result";
  result: MoodResult;
}

export interface WorkerErrorMessage {
  type: "error";
  message: string;
  fatal: boolean;
}

export interface WorkerDisposedMessage {
  type: "disposed";
}

export type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerDisposedMessage;
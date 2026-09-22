import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiPcmStatus, PcmChannelPayload, PcmWindow } from "./contracts";
import { decodePcmWindow } from "./decodePcmWindow";

export type PcmWindowListener = (window: PcmWindow) => void;
export type PcmErrorListener = (error: Error) => void;

export class TauriPcmSource {
  private started = false;
  private channel: Channel<PcmChannelPayload> | null = null;
  private streamEpoch: bigint | null = null;
  private lastSequence = 0n;

  constructor(
    private readonly onWindow: PcmWindowListener,
    private readonly onError: PcmErrorListener,
  ) {}

  async start(): Promise<AiPcmStatus> {
    if (this.started) return invoke<AiPcmStatus>("ai_pcm_status");

    const channel = new Channel<PcmChannelPayload>();
    channel.onmessage = (payload) => this.handlePayload(payload);

    try {
      const status = await invoke<AiPcmStatus>("start_ai_pcm_stream", { channel });
      this.channel = channel;
      this.started = true;
      return status;
    } catch (error) {
      channel.onmessage = () => undefined;
      throw error;
    }
  }

  async stop(): Promise<AiPcmStatus> {
    this.started = false;
    if (this.channel) this.channel.onmessage = () => undefined;
    this.channel = null;
    this.streamEpoch = null;
    this.lastSequence = 0n;
    return invoke<AiPcmStatus>("stop_ai_pcm_stream");
  }

  private handlePayload(payload: PcmChannelPayload): void {
    try {
      const window = decodePcmWindow(payload);
      if (this.streamEpoch !== window.streamEpoch) {
        this.streamEpoch = window.streamEpoch;
        this.lastSequence = 0n;
      }
      if (window.sequence <= this.lastSequence) return;
      this.lastSequence = window.sequence;
      this.onWindow(window);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
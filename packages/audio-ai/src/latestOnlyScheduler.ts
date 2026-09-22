import type { PcmWindow } from "./contracts";

export class LatestOnlyScheduler {
  private busy = false;
  private pending: PcmWindow | null = null;
  private epoch: bigint | null = null;
  private inFlight: PcmWindow | null = null;

  constructor(private readonly dispatch: (window: PcmWindow) => void) {}

  enqueue(window: PcmWindow): void {
    if (this.epoch !== window.streamEpoch) {
      this.epoch = window.streamEpoch;
      this.pending = null;
    }

    if (this.busy) {
      this.pending = window;
      return;
    }

    this.dispatchNow(window);
  }

  complete(streamEpoch: bigint, sequence: bigint): boolean {
    const accepted =
      this.inFlight?.streamEpoch === streamEpoch &&
      this.inFlight.sequence === sequence &&
      this.epoch === streamEpoch;
    this.busy = false;
    this.inFlight = null;
    const next = this.pending;
    this.pending = null;
    if (next) this.dispatchNow(next);
    return accepted;
  }

  reset(): void {
    this.busy = false;
    this.pending = null;
    this.epoch = null;
    this.inFlight = null;
  }

  private dispatchNow(window: PcmWindow): void {
    this.busy = true;
    this.inFlight = window;
    this.dispatch(window);
  }
}
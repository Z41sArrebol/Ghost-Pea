import { describe, expect, it } from "vitest";
import type { PcmWindow } from "../src/contracts";
import { LatestOnlyScheduler } from "../src/latestOnlyScheduler";

function windowAt(sequence: bigint, streamEpoch = 1n): PcmWindow {
  return {
    protocolVersion: 1,
    sampleRateHz: 16_000,
    sampleCount: 48_000,
    streamEpoch,
    sequence,
    payload: new ArrayBuffer(32 + 48_000 * 4),
  };
}

describe("LatestOnlyScheduler", () => {
  it("keeps only the newest window while inference is busy", () => {
    const dispatched: bigint[] = [];
    const scheduler = new LatestOnlyScheduler((window) => dispatched.push(window.sequence));

    scheduler.enqueue(windowAt(1n));
    scheduler.enqueue(windowAt(2n));
    scheduler.enqueue(windowAt(3n));
    expect(scheduler.complete(1n, 1n)).toBe(true);

    expect(dispatched).toEqual([1n, 3n]);
  });

  it("drops a pending window when the stream epoch changes", () => {
    const dispatched: Array<[bigint, bigint]> = [];
    const scheduler = new LatestOnlyScheduler((window) => {
      dispatched.push([window.streamEpoch, window.sequence]);
    });

    scheduler.enqueue(windowAt(1n));
    scheduler.enqueue(windowAt(2n));
    scheduler.enqueue(windowAt(1n, 2n));
    expect(scheduler.complete(1n, 1n)).toBe(false);

    expect(dispatched).toEqual([
      [1n, 1n],
      [2n, 1n],
    ]);
  });
});
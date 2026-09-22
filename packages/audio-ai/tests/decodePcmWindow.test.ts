import { describe, expect, it } from "vitest";
import {
  PCM_HEADER_BYTES,
  PCM_SAMPLE_RATE_HZ,
  PCM_WINDOW_SAMPLES,
  type PcmChannelPayload,
} from "../src/contracts";
import { decodePcmWindow } from "../src/decodePcmWindow";

function encodeTestWindow(): ArrayBuffer {
  const buffer = new ArrayBuffer(PCM_HEADER_BYTES + PCM_WINDOW_SAMPLES * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, PCM_SAMPLE_RATE_HZ, true);
  view.setUint32(8, PCM_WINDOW_SAMPLES, true);
  view.setBigUint64(16, 7n, true);
  view.setBigUint64(24, 9n, true);
  new Float32Array(buffer, PCM_HEADER_BYTES)[0] = 0.25;
  return buffer;
}

describe("decodePcmWindow", () => {
  it.each([
    ["ArrayBuffer", (buffer: ArrayBuffer): PcmChannelPayload => buffer],
    ["Uint8Array", (buffer: ArrayBuffer): PcmChannelPayload => new Uint8Array(buffer)],
    ["number array", (buffer: ArrayBuffer): PcmChannelPayload => Array.from(new Uint8Array(buffer))],
  ])("decodes a valid Rust payload delivered as %s", (_, wrap) => {
    const window = decodePcmWindow(wrap(encodeTestWindow()));

    expect(window.streamEpoch).toBe(7n);
    expect(window.sequence).toBe(9n);
    expect(new Float32Array(window.payload, PCM_HEADER_BYTES, window.sampleCount)[0]).toBe(0.25);
  });

  it("rejects a payload whose sample count disagrees with the contract", () => {
    const payload = encodeTestWindow();
    new DataView(payload).setUint32(8, 1, true);

    expect(() => decodePcmWindow(payload)).toThrow("Unexpected AI PCM sample count");
  });

  it("rejects a truncated payload", () => {
    expect(() => decodePcmWindow(encodeTestWindow().slice(0, -4))).toThrow("payload length mismatch");
  });
});
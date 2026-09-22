import {
  PCM_HEADER_BYTES,
  PCM_PROTOCOL_VERSION,
  PCM_SAMPLE_RATE_HZ,
  PCM_WINDOW_SAMPLES,
  type PcmChannelPayload,
  type PcmWindow,
} from "./contracts";

function toArrayBuffer(payload: PcmChannelPayload): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;

  if (payload instanceof Uint8Array) {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  }

  return Uint8Array.from(payload).buffer;
}

export function decodePcmWindow(payload: PcmChannelPayload): PcmWindow {
  const buffer = toArrayBuffer(payload);
  if (buffer.byteLength < PCM_HEADER_BYTES) {
    throw new Error(`AI PCM payload is too short: ${buffer.byteLength} bytes`);
  }

  const view = new DataView(buffer);
  const protocolVersion = view.getUint32(0, true);
  const sampleRateHz = view.getUint32(4, true);
  const sampleCount = view.getUint32(8, true);
  const reserved = view.getUint32(12, true);
  const streamEpoch = view.getBigUint64(16, true);
  const sequence = view.getBigUint64(24, true);
  const expectedBytes = PCM_HEADER_BYTES + sampleCount * Float32Array.BYTES_PER_ELEMENT;

  if (protocolVersion !== PCM_PROTOCOL_VERSION) {
    throw new Error(`Unsupported AI PCM protocol version: ${protocolVersion}`);
  }
  if (sampleRateHz !== PCM_SAMPLE_RATE_HZ) {
    throw new Error(`Unexpected AI PCM sample rate: ${sampleRateHz}`);
  }
  if (sampleCount !== PCM_WINDOW_SAMPLES) {
    throw new Error(`Unexpected AI PCM sample count: ${sampleCount}`);
  }
  if (reserved !== 0) {
    throw new Error(`AI PCM reserved field must be zero: ${reserved}`);
  }
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`AI PCM payload length mismatch: expected ${expectedBytes}, got ${buffer.byteLength}`);
  }

  return {
    protocolVersion,
    sampleRateHz,
    sampleCount,
    streamEpoch,
    sequence,
    payload: buffer,
  };
}
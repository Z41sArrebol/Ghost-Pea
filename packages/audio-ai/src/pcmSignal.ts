const SILENCE_RMS = 0.001;

export function isSilentPcm(pcm: Float32Array): boolean {
  if (pcm.length === 0) return true;

  let squareSum = 0;
  for (const sample of pcm) {
    if (!Number.isFinite(sample)) {
      throw new Error("AI PCM contains a non-finite sample");
    }
    squareSum += sample * sample;
  }

  return Math.sqrt(squareSum / pcm.length) < SILENCE_RMS;
}
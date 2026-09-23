import * as tf from "@tensorflow/tfjs";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import {
  EssentiaTFInputExtractor,
  TensorflowMusiCNN,
  type MusiCnnFeature,
} from "essentia.js/dist/essentia.js-model.es.js";
import type { MoodScores } from "./contracts";
import { MOOD_MODELS, readPositiveScore } from "./modelManifest";
import { isSilentPcm } from "./pcmSignal";

const MUSICNN_HOP_SIZE = 256;
const SILENT_SCORES: MoodScores = {
  happy: 0,
  sad: 0,
  relaxed: 0,
  aggressive: 0,
};

export class MoodRuntime {
  private extractor: EssentiaTFInputExtractor | null = null;
  private models: TensorflowMusiCNN[] = [];

  async initialize(modelBaseUrl: string): Promise<void> {
    try {
      if (!(await tf.setBackend("webgl"))) throw new Error("WebGL backend is unavailable");
    } catch (error) {
      console.warn("AI WebGL backend unavailable; falling back to CPU", error);
      await tf.setBackend("cpu");
    }
    await tf.ready();
    console.info("AI TensorFlow backend:", tf.getBackend());
    this.extractor = new EssentiaTFInputExtractor(EssentiaWASM, "musicnn");
    this.models = MOOD_MODELS.map(
      ({ directory }) => new TensorflowMusiCNN(tf, `${modelBaseUrl}/${directory}/model.json`),
    );
    await Promise.all(this.models.map((model) => model.initialize()));
  }

  async predict(pcm: Float32Array): Promise<MoodScores> {
    if (!this.extractor || this.models.length !== MOOD_MODELS.length) {
      throw new Error("Mood runtime is not initialized");
    }
    if (isSilentPcm(pcm)) return { ...SILENT_SCORES };

    const feature: MusiCnnFeature = this.extractor.computeFrameWise(pcm, MUSICNN_HOP_SIZE);
    const predictions = await Promise.all(this.models.map((model) => model.predict(feature, true)));
    return Object.fromEntries(
      MOOD_MODELS.map((definition, index) => [
        definition.key,
        readPositiveScore(predictions[index], definition.positiveClassIndex),
      ]),
    ) as unknown as MoodScores;
  }

  dispose(): void {
    for (const model of this.models) model.dispose();
    this.models = [];
    this.extractor?.delete();
    this.extractor = null;
  }
}
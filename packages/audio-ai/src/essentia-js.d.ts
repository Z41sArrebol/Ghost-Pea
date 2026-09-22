declare module "essentia.js/dist/essentia-wasm.es.js" {
  export const EssentiaWASM: unknown;
}

declare module "essentia.js/dist/essentia.js-model.es.js" {
  export interface MusiCnnFeature {
    melSpectrum: Float32Array | number[][];
    patchSize: 187;
    frameSize: number;
    melBandsSize: 96;
  }

  export class EssentiaTFInputExtractor {
    constructor(module: unknown, extractorType: "musicnn", isDebug?: boolean);
    computeFrameWise(audioSignal: Float32Array, hopSize?: number): MusiCnnFeature;
    delete(): void;
    shutdown(): void;
  }

  export class TensorflowMusiCNN {
    constructor(tfjs: unknown, modelUrl: string, verbose?: boolean);
    initialize(): Promise<void>;
    predict(feature: MusiCnnFeature, zeroPadding?: boolean): Promise<unknown[]>;
    dispose(): void;
  }
}
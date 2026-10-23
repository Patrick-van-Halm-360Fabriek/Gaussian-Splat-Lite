import type { Camera, Matrix4, RenderTarget, Vector2 } from "three";

/** Capture sizing, projection jitter and history lifetime for neural denoising. */
export declare function createNeuralDenoiseState(
  targets: RenderTarget[],
  margin: number,
): {
  size: Vector2;
  projection: Matrix4;
  valid: boolean;
  historyIndex: number;
  jitterIndex: number;
  reset(): void;
  setSize(width: number, height: number): void;
  setStencil(stencil: boolean): void;
  beginCapture(camera: Camera): void;
  endCapture(camera: Camera): void;
  advance(): void;
};
export declare const getUnjitteredProjection: (
  camera: Camera,
) => Matrix4 | undefined;

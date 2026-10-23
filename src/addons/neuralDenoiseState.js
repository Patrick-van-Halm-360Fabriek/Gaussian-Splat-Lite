import { DepthFormat, DepthStencilFormat, Matrix4, Vector2 } from "three";

/** Capture sizing, projection jitter and history lifetime for neural denoising. */
export function createNeuralDenoiseState(targets, margin) {
  const baseProjection = new Matrix4();
  return {
    size: new Vector2(1, 1),
    projection: new Matrix4(),
    valid: false,
    historyIndex: 0,
    jitterIndex: 0,
    reset() {
      this.valid = false;
      this.jitterIndex = 0;
    },
    setSize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      const [source, ...others] = targets;
      if (source.width === w + margin && source.height === h + margin) return;
      source.setSize(w + margin, h + margin);
      for (const target of others) target.setSize(w, h);
      this.size.set(w, h);
      this.reset();
    },
    setStencil(stencil) {
      const source = targets[0];
      const depthTexture = source.depthTexture;
      if (source.stencilBuffer === stencil) return;
      source.dispose();
      source.stencilBuffer = stencil;
      depthTexture.format = stencil ? DepthStencilFormat : DepthFormat;
    },
    beginCapture(camera) {
      jitterProjection(
        camera,
        baseProjection,
        this.jitterIndex,
        this.size.x,
        this.size.y,
      );
    },
    endCapture(camera) {
      this.projection.copy(camera.projectionMatrix);
      restoreProjection(camera, baseProjection);
    },
    advance() {
      this.historyIndex = 1 - this.historyIndex;
      this.valid = true;
      this.jitterIndex = (this.jitterIndex + 1) % jitterOffsets.length;
    },
  };
}

function halton(index, base) {
  let i = index;
  let fraction = 1;
  let result = 0;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}
const jitterOffsets = Array.from({ length: 32 }, (_, i) => [
  halton(i + 1, 2) - 0.5,
  halton(i + 1, 3) - 0.5,
]);
// Native Splat projection uses the unjittered matrix for its compute cache.
const projections = new WeakMap();
export const getUnjitteredProjection = (camera) => projections.get(camera);
function jitterProjection(camera, base, index, width, height) {
  base.copy(camera.projectionMatrix);
  projections.set(camera, base);
  const [x, y] = jitterOffsets[index];
  const elements = camera.projectionMatrix.elements;
  for (let column = 0; column < 16; column += 4) {
    elements[column] -= ((2 * x) / width) * elements[column + 3];
    elements[column + 1] += ((2 * y) / height) * elements[column + 3];
  }
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
function restoreProjection(camera, base) {
  projections.delete(camera);
  camera.projectionMatrix.copy(base);
  camera.projectionMatrixInverse.copy(base).invert();
}

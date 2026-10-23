import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { NeuralDenoiseMode } from "./NeuralDenoiseNode.js";

/** Per-eye neural denoising and presentation during an active WebXR session. */
export declare class NeuralDenoiseXR {
  readonly renderer: WebGLRenderer | WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  readonly mode: NeuralDenoiseMode;
  readonly msaa: boolean;
  stabilize: boolean;
  private views;
  private output;
  private readonly nodeRenderer;
  private readonly onSessionEnd;
  constructor(
    renderer: WebGLRenderer | WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    mode?: NeuralDenoiseMode,
    msaa?: boolean,
  );
  private createViews;
  /** Capture, denoise and present each eye during an active XR animation frame. */
  render(): void;
  /** Discards both eyes' history after a camera cut or scene replacement. */
  reset(): void;
  private disposeViews;
  dispose(): void;
}

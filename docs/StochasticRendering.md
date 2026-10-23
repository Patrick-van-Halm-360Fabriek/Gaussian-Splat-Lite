# Stochastic rendering

[Back to documentation](../README.md#documentation)

Stochastic rendering is an optional way for `GaussianSplatRenderer` to draw transparency. It produces visible noise, so pair it with the experimental neural denoiser to get a smooth image. Sorted alpha blending remains the default.

Stochastic rendering works on WebGPU, WebGL2, and `WebGPURenderer`'s WebGL2 fallback, including WebXR. For immersive rendering, use [NeuralDenoiseXR](NeuralDenoiseNode.md#webxr).

## Turn it on

With an existing [GaussianSplatRenderer](GaussianSplatRenderer.md):

```js
splatRenderer.stochastic = true;
```

Splats are sorted from front to back by default. To skip this sorting:

```js
splatRenderer.stochasticSort = false;
```

Both can be changed at any time. While stochastic rendering is active, Splats are drawn without blending and with depth testing and depth writing on. Your `transparent`, `depthTest`, and `depthWrite` settings apply again when you return to sorted rendering.

## Smooth the noise

Use [`NeuralDenoiseNode`](NeuralDenoiseNode.md#webgpurenderer-neuraldenoisenode) with `WebGPURenderer`, or [`NeuralDenoisePass`](NeuralDenoiseNode.md#webglrenderer-neuraldenoisepass) with `WebGLRenderer`. The library does not turn denoising on for you. The examples assume an existing `renderer`, `scene`, `camera`, and `splatRenderer`, with one camera outside WebXR.

### WebGPURenderer: NeuralDenoiseNode

Use this on both WebGPU and the WebGL2 fallback, after `await renderer.init()`:

```js
import { NeuralDenoiseNode } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

splatRenderer.stochastic = true;

const denoise = new NeuralDenoiseNode(scene, camera);
// Chain Bloom or other effects from denoise here.
const pipeline = new RenderPipeline(renderer, denoise);

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  pipeline.render();
});
```

See [Neural denoising](NeuralDenoiseNode.md) for modes, MSAA and WebGL2 requirements.

### WebGLRenderer: NeuralDenoisePass

```js
import { NeuralDenoisePass } from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

splatRenderer.stochastic = true;

const denoise = new NeuralDenoisePass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(denoise);
// Insert Bloom or other effects here.
composer.addPass(new OutputPass());

renderer.setAnimationLoop(() => {
  // Update controls / animation here.
  composer.render();
});
```

`NeuralDenoisePass` takes the place of `RenderPass`. On resize, call `composer.setSize(width, height)` along with the renderer.

It has the same options and requirements as `NeuralDenoiseNode` on WebGL2.

### History and on-demand rendering

- Call `reset()` after a camera cut or a scene replacement.
- With on-demand rendering, keep rendering for several frames after the camera, a model, or streamed content changes, and after the Splat renderer's `onDirty` callback, so the noise can settle.

See [Neural denoising](NeuralDenoiseNode.md) for effects, depth, color, and cleanup.

## Control the noise pattern

The noise pattern changes on every render so neural denoising can smooth it over time. To keep it fixed, or to control it from your own render loop:

```js
splatRenderer.autoAdvanceStochasticSample = false;
splatRenderer.stochasticSample = 0; // Keep fixed, or increase it yourself.
```

When you advance it yourself, increase it by one for each render of the scene. The patterns repeat every 32 samples; a smooth image is not guaranteed after exactly 32 renders. Set `autoAdvanceStochasticSample = true` to hand control back.

## Return to sorted rendering

```js
splatRenderer.stochastic = false;
```

The switch, in either direction, takes effect on a later frame rather than immediately. `stochasticActive` tells you which mode is being drawn; keep your neural denoiser running until it is `false`. With `autoUpdate = false`, update before drawing:

```js
await splatRenderer.update({ scene, camera });
renderer.render(scene, camera);
```

If you keep neural denoising running with sorted rendering, set `splatRenderer.depthWrite = true` so it can use the Splats' depth.

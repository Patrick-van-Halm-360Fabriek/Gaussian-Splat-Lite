import { DefaultLoadingManager } from "three";
import { abortable, linkedAbortController } from "../../../runtime/abort.js";
import { StreamWorkerPool } from "../StreamWorkerPool.js";
import { MAX_INPUT_BYTES, sourceLimits } from "./memory.js";
import { logicalUrl, readSceneBytes } from "./resources.js";

/** Worker leases retain cached sources; only extracted copies cross back to the scene. */
export class SceneStreamLoader {
  constructor(options, onChange) {
    this.options = options;
    this.onChange = onChange;
    this.disposed = false;
    this.controller = new AbortController();
    this.workerLifetimes = new WeakMap();
    this.workerHeapLimits = new WeakMap();
  }
  async load(source, signal) {
    const request = linkedAbortController(this.controller.signal, signal);
    try {
      return await this.loadActive(source, request.signal);
    } finally {
      request.cleanup();
    }
  }
  async loadActive(source, signal) {
    signal.throwIfAborted();
    this.workerModule ??= import("./SceneStreamWorker.js");
    const { SceneStreamWorker } = await abortable(this.workerModule, signal);
    signal.throwIfAborted();
    if (this.disposed)
      throw new DOMException("Scene loader disposed", "AbortError");
    this.pool ??= new StreamWorkerPool(() => {
      let finished;
      const lifetime = new Promise((resolve) => {
        finished = resolve;
      });
      const worker = new SceneStreamWorker(() => {
        finished();
        this.onChange();
      });
      this.workerLifetimes.set(worker, lifetime);
      return worker;
    }, 1);
    const manager = this.options.manager ?? DefaultLoadingManager;
    return this.pool.run(
      {
        signal,
        manager,
        cancel: (worker, id) => worker.call("releaseSceneSource", { id }),
      },
      async ({ worker, id, signal, retain, start, progress }) => {
        const pin = () => {
          if (worker.disposed) return;
          try {
            source.pinWasm?.(
              worker,
              worker.peakWasmMemoryBytes ?? 0,
              this.workerLifetimes.get(worker),
            );
          } catch (error) {
            worker.dispose(error);
            throw error;
          }
        };
        try {
          const url = logicalUrl(manager.resolveURL(source.url));
          start(url);
          const shUrl = source.shByteLength
            ? logicalUrl(manager.resolveURL(source.shUrl))
            : undefined;
          let limits =
            source.count === undefined ? undefined : sourceLimits(source);
          const sampledWasm = worker.peakWasmMemoryBytes ?? 0;
          const retainedWasm = Math.max(
            sampledWasm,
            this.workerHeapLimits.get(worker) ?? 0,
          );
          if (limits && retainedWasm > limits.maxWasmBytes) {
            if (!source.admit)
              throw new Error(
                "Retained WASM capacity requires source re-admission",
              );
            if (source.maxWasmBytes !== undefined)
              throw new Error(
                "Retained WASM capacity exceeds source.maxWasmBytes",
              );
            limits = source.admit({
              maxWasmBytes: Math.max(
                retainedWasm,
                sampledWasm + limits.maxWasmBytes,
              ),
            });
          }
          if (limits) this.workerHeapLimits.set(worker, limits.maxWasmBytes);
          let externalBytes = 0;
          let rootBytes;
          let statusError;
          const info = await worker
            .call(
              "loadSceneSource",
              {
                id,
                source,
                limits,
                admissionEnabled: Boolean(source.admit),
                url,
                shUrl,
                hasFileResolver: source.codec === "sog",
                requestHeader:
                  new URL(source.url).origin ===
                  new URL(logicalUrl(this.options.url)).origin
                    ? this.options.requestHeader
                    : undefined,
                withCredentials:
                  new URL(source.url).origin ===
                    new URL(logicalUrl(this.options.url)).origin &&
                  this.options.withCredentials,
                shRequestHeader:
                  source.shByteLength &&
                  new URL(source.shUrl).origin ===
                    new URL(logicalUrl(this.options.url)).origin
                    ? this.options.requestHeader
                    : undefined,
                shWithCredentials:
                  Boolean(source.shByteLength) &&
                  new URL(source.shUrl).origin ===
                    new URL(logicalUrl(this.options.url)).origin &&
                  this.options.withCredentials,
              },
              {
                onStatus: async (status) => {
                  if (statusError || signal.aborted) return;
                  try {
                    if ("admission" in status) {
                      if (!source.admit)
                        throw new Error(
                          "Source header needs a larger CPU reservation",
                        );
                      limits = source.admit(status.admission);
                      this.workerHeapLimits.set(worker, limits.maxWasmBytes);
                      await worker.call("admitSceneSource", { id, limits });
                    }
                    if ("loaded" in status) {
                      rootBytes ??= status.loaded;
                      progress(status.loaded);
                    }
                    if ("assetRequest" in status)
                      await worker.call("resolveAsset", {
                        requestId: status.assetRequest,
                        url: logicalUrl(manager.resolveURL(status.url)),
                      });
                    if ("fileRequest" in status) {
                      const assetUrl = new URL(status.filename, source.url)
                        .href;
                      const input = await readSceneBytes(
                        assetUrl,
                        this.options,
                        signal,
                        (limits?.maxInputBytes ?? MAX_INPUT_BYTES) -
                          externalBytes -
                          (rootBytes ?? 0),
                      );
                      externalBytes += input.byteLength;
                      await worker.call("resolveFile", {
                        requestId: status.fileRequest,
                        input,
                      });
                    }
                  } catch (error) {
                    statusError ??= error;
                    // A sidecar failure belongs to this load, not the worker's other caches.
                    await worker
                      .call("releaseSceneSource", { id })
                      .catch(() => {});
                  }
                },
              },
            )
            .catch((error) => {
              throw statusError ?? error;
            });
          if (statusError) throw statusError;
          signal.throwIfAborted();
          pin();
          const release = retain();
          let disposed = false;
          return {
            info,
            extract: (ranges) => {
              if (disposed) throw new Error("Scene source is no longer cached");
              return worker.call("extractSceneRanges", {
                id,
                ranges,
                sourceOffset: source.sourceOffset,
              });
            },
            dispose: () => {
              if (disposed) return;
              disposed = true;
              return (
                worker.disposed
                  ? Promise.resolve()
                  : worker.call("releaseSceneSource", { id }).catch(() => {})
              ).finally(release);
            },
          };
        } catch (error) {
          // Cancellation can arrive after a synchronous decode cached its result.
          if (!worker.disposed)
            await worker.call("releaseSceneSource", { id }).catch(() => {});
          pin();
          throw error;
        }
      },
    );
  }
  get stats() {
    return {
      downloadedBytes: this.pool?.downloadedBytes ?? 0,
      peakWasmMemoryBytes: this.pool?.peakWasmMemoryBytes ?? 0,
      // Linear memory does not shrink; completed RPC samples describe retained live workers.
      wasmMemoryBytes: (this.pool?.workers ?? []).reduce(
        (bytes, worker) =>
          bytes + (worker.disposed ? 0 : worker.peakWasmMemoryBytes),
        0,
      ),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort(
      new DOMException("Scene loader disposed", "AbortError"),
    );
    this.pool?.dispose();
  }
}

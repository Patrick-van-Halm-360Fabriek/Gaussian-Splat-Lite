import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import init from "gaussian-splat-rs";
import { SceneStreamLoader } from "../src/loaders/stream/scene-stream/SceneStreamLoader.js";
import { createSceneStreamHandlers } from "../src/loaders/stream/scene-stream/workerHandlers.js";

test("LCC companions scope credentials to the original scene origin", async (context) => {
  await init({
    module_or_path: await readFile(
      new URL(
        "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
        import.meta.url,
      ),
    ),
  });
  const scene = "https://scene.invalid";
  const other = "https://other.invalid";
  for (const [name, baseOrigin, shOrigin, resolvedShOrigin] of [
    ["same-origin companions", scene, scene, scene],
    ["cross-origin SH", scene, other, other],
    ["same-origin SH with cross-origin base", other, scene, scene],
    ["SH remapped cross-origin", scene, scene, other],
  ]) {
    await context.test(name, async (context) => {
      const requests = [];
      context.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({
          url,
          authorization: options.headers.get("Authorization"),
          credentials: options.credentials,
        });
        const size = url.endsWith("sh.bin") ? 64 : 32;
        return new Response(new Uint8Array(size), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${size - 1}/${size}` },
        });
      });
      const handlers = createSceneStreamHandlers(
        () => {
          throw new Error("Unexpected ordinary decoder");
        },
        () => ({
          numSplats: 1,
          splat0: new Uint32Array(4),
          splat1: new Uint32Array(4),
        }),
      );
      class DirectWorker {
        disposed = false;
        peakWasmMemoryBytes = 0;
        async call(name, args, options) {
          return handlers[name](args, {
            sendStatus: (status) => options?.onStatus?.(status),
          });
        }
        dispose() {
          this.disposed = true;
        }
      }
      const loader = new SceneStreamLoader(
        {
          url: `${scene}/scene.lcc`,
          requestHeader: { Authorization: "Bearer scene-secret" },
          withCredentials: true,
          manager: {
            resolveURL(url) {
              return url.endsWith("sh.bin")
                ? `${resolvedShOrigin}/sh.bin`
                : url;
            },
            itemStart() {},
            itemEnd() {},
            itemError() {},
          },
        },
        () => {},
      );
      loader.workerModule = Promise.resolve({
        SceneStreamWorker: DirectWorker,
      });
      let handle;
      try {
        handle = await loader.load(
          {
            codec: "lcc",
            url: `${baseOrigin}/base.bin`,
            shUrl: `${shOrigin}/sh.bin`,
            count: 1,
            shDegree: 3,
            offset: 0,
            byteLength: 32,
            shOffset: 0,
            shByteLength: 64,
            inputBytes: 96,
            context: { count: 1 },
          },
          new AbortController().signal,
        );
        assert.deepEqual(requests, [
          {
            url: `${baseOrigin}/base.bin`,
            authorization: baseOrigin === scene ? "Bearer scene-secret" : null,
            credentials: baseOrigin === scene ? "include" : "same-origin",
          },
          {
            url: `${resolvedShOrigin}/sh.bin`,
            authorization:
              shOrigin === scene && resolvedShOrigin === scene
                ? "Bearer scene-secret"
                : null,
            credentials:
              shOrigin === scene && resolvedShOrigin === scene
                ? "include"
                : "same-origin",
          },
        ]);
      } finally {
        await handle?.dispose();
        loader.dispose();
      }
    });
  }
});

// WorkerRpc's bundler-only WASM import is irrelevant to these transport tests.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith("/src/runtime/wasm.js"))
        return {
          format: "module",
          source: "export const WASM_MODULE = Promise.resolve(null);",
          shortCircuit: true,
        };
      return nextLoad(url, context);
    }
  `)}`,
);
const { WorkerRpc } = await import("../src/runtime/WorkerRpc.js");

for (const failure of ["missing", "cancel", "resolver"]) {
  test(`queued SOG sidecar ${failure} settles without evicting another cache`, async (context) => {
    const controller = new AbortController();
    const retained = new AbortController();
    const requests = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      requests.push(url);
      if (url.endsWith("missing.webp")) {
        if (failure === "cancel") {
          controller.abort();
          throw controller.signal.reason;
        }
        return new Response("missing", { status: 404 });
      }
      assert.ok(url.endsWith("hanging.webp"));
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      });
    });
    class Transport {
      cached = new Set();
      emit(data) {
        queueMicrotask(() =>
          this.onmessage({ data: { wasmMemoryBytes: 0, ...data } }),
        );
      }
      postMessage({ id, name, args }) {
        if (name === "init-wasm") return;
        if (name === "loadSceneSource") {
          if (args.source.codec !== "sog") {
            this.cached.add(args.id);
            this.emit({
              id,
              result: { numSplats: 1, numSh: 0, byteLength: 32 },
            });
            return;
          }
          this.loadId = id;
          this.emit({ id, status: { loaded: 1 } });
          this.emit({
            id,
            status: { fileRequest: 1, filename: "missing.webp" },
          });
          this.emit({
            id,
            status: { fileRequest: 2, filename: "hanging.webp" },
          });
        } else if (name === "releaseSceneSource") {
          this.cached.delete(args.id);
          if (this.loadId !== undefined) {
            this.emit({
              id: this.loadId,
              error: new DOMException("Source canceled", "AbortError"),
            });
            this.loadId = undefined;
          }
          this.emit({ id, result: undefined });
        } else if (name === "extractSceneRanges") {
          if (this.cached.has(args.id)) this.emit({ id, result: args.ranges });
          else this.emit({ id, error: new Error("Source no longer cached") });
        } else {
          throw new Error(`Unexpected RPC ${name}`);
        }
      }
      terminate() {
        this.cached.clear();
      }
    }
    class TestWorker extends WorkerRpc {
      constructor(onDispose) {
        super(new Transport(), onDispose);
      }
    }
    const loader = new SceneStreamLoader(
      {
        url: "https://scene.invalid/scene.lcc2",
        manager:
          failure === "resolver"
            ? {
                resolveURL(url) {
                  if (url.endsWith("missing.webp"))
                    throw new Error("Missing companion");
                  return url;
                },
                itemStart() {},
                itemEnd() {},
                itemError() {},
              }
            : undefined,
      },
      () => {},
    );
    loader.workerModule = Promise.resolve({ SceneStreamWorker: TestWorker });
    const first = await loader.load(
      { codec: "ply", url: "https://scene.invalid/first.ply" },
      retained.signal,
    );
    const pending = loader.load(
      { codec: "sog", url: "https://scene.invalid/meta.json" },
      controller.signal,
    );
    let timeout;
    try {
      await Promise.race([
        assert.rejects(
          pending,
          failure === "cancel"
            ? { name: "AbortError" }
            : failure === "resolver"
              ? /Missing companion/
              : /HTTP 404/,
        ),
        new Promise((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Sidecar failure did not settle the load")),
            1000,
          );
        }),
      ]);
      assert.equal(retained.signal.aborted, false);
      assert.equal(controller.signal.aborted, failure === "cancel");
      assert.deepEqual(
        requests,
        failure === "resolver" ? [] : ["https://scene.invalid/missing.webp"],
      );
      assert.deepEqual(await first.extract([{ start: 0, count: 1 }]), [
        { start: 0, count: 1 },
      ]);
      const next = await loader.load(
        { codec: "ply", url: "https://scene.invalid/next.ply" },
        retained.signal,
      );
      await next.dispose();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await pending.catch(() => {});
      await first.dispose();
      loader.dispose();
    }
  });
}

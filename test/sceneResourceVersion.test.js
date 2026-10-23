import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import init from "gaussian-splat-rs";
import { createSceneStreamHandlers } from "../src/loaders/stream/scene-stream/workerHandlers.js";

test("new LCC workers retain the manifest probe's resource validator", async (context) => {
  await init({
    module_or_path: await readFile(
      new URL(
        "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
        import.meta.url,
      ),
    ),
  });
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(new Uint8Array(32), {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-31/32",
          "Content-Length": "32",
          ETag: '"changed"',
        },
      }),
  );
  let decoded = 0;
  const handlers = createSceneStreamHandlers(
    () => {},
    () => {
      decoded++;
      throw new Error("Unexpected decode");
    },
  );
  const url = "https://scene.invalid/data.bin";
  await assert.rejects(
    handlers.loadSceneSource(
      {
        id: 1,
        url,
        source: {
          codec: "lcc",
          url,
          count: 1,
          shDegree: 0,
          offset: 0,
          byteLength: 32,
          inputBytes: 32,
          context: { count: 1 },
          resourceState: {
            total: 32,
            validator: '"original"',
            validatorHeader: "ETag",
          },
        },
      },
      { sendStatus() {} },
    ),
    /resource version changed/,
  );
  assert.equal(decoded, 0);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeShRgbToArray } from "../src/data/splatCodec.js";
import { decodeSplat } from "../src/data/unpack.js";
import { sourceLimits } from "../src/loaders/stream/scene-stream/limits.js";
import { createSharedPlyScene } from "./lcc2Fixture.js";

const glue = new URL(
  "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs.js",
  import.meta.url,
);
const binary = new URL(
  "../rust/gaussian-splat-rs/pkg/gaussian_splat_rs_bg.wasm",
  import.meta.url,
);
const available = existsSync(glue) && existsSync(binary);
let instance = 0;
async function wasm() {
  const module = await import(`${glue.href}?conformance=${++instance}`);
  module.initSync({ module: await readFile(binary) });
  assert.equal(
    module.decoder_budget_supported(),
    true,
    "Rebuild WASM after decoder changes",
  );
  return module;
}

function assertPacked(data, count, degree) {
  assert.equal(data.numSplats, count);
  assert.equal(data.maxShDegree, degree);
  assert.ok(data.maxSplats >= count);
  for (const [name, Type, stride] of [
    ["splat0", Uint32Array, 4],
    ["splat1", Uint32Array, 4],
    ["sortCenters", Float32Array, 3],
    ...Array.from({ length: degree ? 4 : 0 }, (_, block) => [
      `shBlock${block}`,
      Uint32Array,
      4,
    ]),
  ]) {
    assert.ok(data[name] instanceof Type, `${name} type`);
    assert.equal(data[name].length, data.maxSplats * stride, `${name} length`);
  }
}

function assertSh(data, index, coefficient, expected, tolerance) {
  const actual = [0, 0, 0];
  decodeShRgbToArray(
    data[`shBlock${coefficient >> 2}`][index * 4 + (coefficient & 3)],
    actual,
  );
  expected.forEach((value, channel) =>
    assert.ok(
      Math.abs(actual[channel] - value) <= tolerance,
      `record ${index} SH ${coefficient}/${channel}: ${actual[channel]} != ${value}`,
    ),
  );
}

test(
  "built WASM preserves PLY record slots and SH under finite admission",
  { skip: !available },
  async () => {
    const module = await wasm();
    const { ply } = createSharedPlyScene();
    const limits = sourceLimits({ codec: "ply", count: 8, shDegree: 3 });
    const decoder = module.decode_to_splats(
      "ply",
      "shared.ply",
      limits.maxPoints,
      limits.maxDecoderBytes,
      limits.maxWasmBytes,
    );
    decoder.set_expected_input_size(ply.length);
    decoder.push(ply);
    const data = decoder.finish();
    assertPacked(data, 8, 3);
    for (let index = 0; index < 8; index++) {
      const splat = decodeSplat([data.splat0, data.splat1], index);
      assert.equal(splat.center.x, index - 3);
      assert.equal(splat.opacity, index === 0 ? 0 : 0.5);
      assert.ok(Math.abs(splat.scales.x - 0.04) < 0.005);
    }
    for (const index of [0, 7])
      for (const coefficient of [2, 3, 7, 8, 11, 12, 14]) {
        const expected = [0, 1, 2].map(
          (channel) => (channel * 15 + coefficient + 1) * (index + 1) * 0.001,
        );
        assertSh(
          data,
          index,
          coefficient,
          expected,
          0.00001 + expected[2] * 0.005,
        );
      }
    assert.ok(module.wasm_memory_bytes() <= limits.maxWasmBytes);
  },
);

test(
  "built WASM rejects excessive header/output admission before publication",
  { skip: !available },
  async () => {
    const module = await wasm();
    const { ply } = createSharedPlyScene();
    for (const [points, bytes, message] of [
      [7, 64 * 1024 ** 2, /maxPoints/],
      [8, 100, /memory budget/],
    ]) {
      const decoder = module.decode_to_splats(
        "ply",
        undefined,
        points,
        bytes,
        32 * 1024 ** 2,
      );
      try {
        decoder.set_expected_input_size(ply.length);
        assert.throws(() => decoder.push(ply), message);
      } finally {
        decoder.free();
      }
    }
  },
);

test(
  "built WASM accepts budgeted LCC Portable, Quality and environment contexts",
  { skip: !available },
  async () => {
    const module = await wasm();
    const base = new Uint8Array(32);
    new DataView(base.buffer).setFloat32(0, 1.25, true);
    base.set([128, 64, 255, 0], 12);
    const shSamples = [
      [3, 2047, [2, -2, -3]],
      [7, 1023 << 11, [-1, 4, -3]],
      [8, (2047 << 21) >>> 0, [-1, -2, 6]],
      [12, 0xffffffff, [2, 4, 6]],
    ];
    new DataView(base.buffer).setUint32(
      22,
      (512 | (512 << 10) | (512 << 20) | (3 << 30)) >>> 0,
      true,
    );
    for (const fileType of ["Portable", "Quality"])
      for (const environment of [false, true]) {
        const quality = fileType === "Quality";
        const sh = quality ? new Uint8Array(64) : new Uint8Array(0);
        if (quality)
          for (const [coefficient, word] of shSamples)
            new DataView(sh.buffer).setUint32(coefficient * 4, word, true);
        const input = environment ? new Uint8Array([...base, ...sh]) : base;
        const limits = sourceLimits({
          codec: "lcc",
          count: 1,
          shDegree: quality ? 3 : 0,
          inputBytes: base.length + sh.length,
        });
        const context = {
          version: "5.0",
          encoding: "COMPRESS",
          fileType,
          count: 1,
          environment,
          scaleMin: [0.1, 0.1, 0.1],
          scaleMax: [0.1, 0.1, 0.1],
          ...(quality ? { shMin: [-1, -2, -3], shMax: [2, 4, 6] } : {}),
          maxPoints: limits.maxPoints,
          maxDecoderBytes: limits.maxDecoderBytes,
          maxWasmBytes: limits.maxWasmBytes,
        };
        const data = module.decodeLcc(
          input,
          environment ? new Uint8Array(0) : sh,
          JSON.stringify(context),
        );
        assertPacked(data, 1, quality ? 3 : 0);
        const splat = decodeSplat([data.splat0, data.splat1], 0);
        assert.equal(splat.center.x, 1.25);
        assert.equal(splat.opacity, 0);
        assert.ok(Math.abs(splat.scales.x - 0.1) < 0.005);
        if (quality)
          for (const [coefficient, , expected] of shSamples)
            assertSh(data, 0, coefficient, expected, 0.02);
        assert.ok(module.wasm_memory_bytes() <= limits.maxWasmBytes);
      }
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { SH_ARRAY_COUNTS } from "../src/data/splatData.js";
import { selectLccUnits } from "../src/loaders/stream/lcc-stream/lccScene.js";
import { SceneStreamScheduler } from "../src/loaders/stream/scene-stream/SceneStreamScheduler.js";
import {
  SceneMemory,
  regionMemory,
  sourceMemory,
} from "../src/loaders/stream/scene-stream/memory.js";
import { SceneSources } from "../src/loaders/stream/scene-stream/resources.js";
import { readLccFixture } from "./lccFixture.js";

const bounds = { min: [-1, -1, -3], max: [1, 1, -1] };
const file = (key, count, shDegree = 0) => ({
  key,
  count,
  shDegree,
  codec: "ply",
  sourceOffset: 100,
  url: `https://scene.invalid/${key}.ply`,
});
const small = file("small", 40_000, 1);
const large = file("large", 50_000);
const parentFile = file("parent", 1);
const range = (source, start, count, node) => ({ source, start, count, node });
const cut = {
  id: "cut",
  count: 6,
  ranges: [
    range(small, 0, 2, "small-first"),
    range(large, 20, 3, "large"),
    range(small, 6, 1, "small-last"),
  ],
};
const parent = {
  id: "parent",
  count: 1,
  ranges: [range(parentFile, 0, 1, "parent")],
};
const shared = {
  id: "shared",
  count: 2,
  ranges: [
    range(large, 30, 1, "other-node"),
    range(small, 30, 1, "other-small"),
  ],
};
const regionCpu = (rep) =>
  rep.ranges.reduce(
    (sum, item) => sum + regionMemory(item.count, item.source.shDegree).cpu,
    0,
  );
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate, scheduler) {
  for (let attempt = 0; attempt < 100; attempt++) {
    scheduler?.update();
    if (predicate()) return;
    await tick();
  }
  assert.fail(`Pipeline did not settle: ${JSON.stringify(scheduler?.stats)}`);
}
function harness(
  context,
  {
    model,
    reps = model ? model.units.map((unit) => unit.representations[0]) : [cut],
    initial = reps.map((rep, index) => [
      model?.units[index].id ?? `unit-${index}`,
      rep,
    ]),
    policy,
    gpu = 1024 ** 3,
    beforeLoad,
    beforeExtract,
    beforeDispose,
    cpu = reps.reduce((sum, rep) => sum + regionCpu(rep), 0) +
      sourceMemory(large) +
      65536,
  } = {},
) {
  const loads = [];
  const releases = [];
  const live = new Set();
  const batches = [];
  const errors = [];
  const samples = [];
  let selected = new Map(initial);
  const sample = () => samples.push(scheduler.stats.residentCpuBytes);
  const scheduler = new SceneStreamScheduler(
    {
      url: "https://scene.invalid/scene.lcc2",
      maxResidentCpuBytes: cpu,
      maxResidentGpuBytes: gpu,
      onChange: sample,
      onError: (error) => errors.push(error),
    },
    {
      name: "pipeline",
      read: async () =>
        model ?? {
          units: reps.map((rep, index) => ({
            id: `unit-${index}`,
            boundingBox: bounds,
            representations: [rep],
          })),
          boundingBox: bounds,
          metadataBytes: 0,
        },
      select: policy ?? (() => new Map(selected)),
    },
    {
      loader: {
        stats: {},
        dispose() {},
        async load(source, signal) {
          loads.push(source.key);
          live.add(source.key);
          sample();
          await beforeLoad?.(source, signal);
          let disposed;
          return {
            info: {
              numSplats: source.count,
              numSh: source.shDegree,
              byteLength: source.count * 48,
            },
            async extract(ranges) {
              sample();
              await beforeExtract?.(source, ranges);
              return ranges.map((item) => ({
                numSplats: item.count,
                marker: `${source.key}:${item.start}`,
                extra: Object.fromEntries(
                  Array.from(
                    { length: SH_ARRAY_COUNTS[source.shDegree] },
                    (_, index) => [`shBlock${index}`, new Uint32Array(4)],
                  ),
                ),
              }));
            },
            dispose() {
              disposed ??= (async () => {
                await beforeDispose?.(source);
                live.delete(source.key);
                releases.push(source.key);
                sample();
              })();
              return disposed;
            },
          };
        },
      },
      createBatch: async (count, degree) => {
        const batch = {
          count,
          numSh: degree,
          userData: {},
          layers: new THREE.Layers(),
          visible: false,
          disposed: false,
          writeRegion(_offset, data) {
            this.marker = data.marker;
            sample();
          },
          setRegionOpacity() {
            this.visible = true;
          },
          removeFromParent() {
            this.visible = false;
          },
          dispose() {
            this.disposed = true;
          },
        };
        batches.push(batch);
        return batch;
      },
    },
  );
  scheduler.setCamera(new THREE.PerspectiveCamera(60, 1, 0.1, 100));
  context.after(async () => {
    scheduler.dispose();
    await tick();
  });
  return {
    scheduler,
    loads,
    releases,
    live,
    batches,
    errors,
    samples,
    cpu,
    select: (next) => {
      selected = new Map(next);
      scheduler.update();
    },
  };
}

test(
  "a composite whose files fit separately but not together publishes in original range order",
  { timeout: 3000 },
  async (context) => {
    const state = harness(context);
    assert.ok(
      regionCpu(cut) + sourceMemory(small) + sourceMemory(large) > state.cpu,
    );
    await state.scheduler.initialized;
    await until(
      () =>
        state.scheduler.stats.loadProgress === 1 || state.scheduler.disposed,
      state.scheduler,
    );
    await state.scheduler.firstRenderable;
    await until(() => !state.scheduler.jobs.size, state.scheduler);
    assert.deepEqual(state.loads, ["large", "small"]);
    assert.deepEqual(state.releases, ["large", "small"]);
    assert.deepEqual(
      state.scheduler.shown.get("unit-0").batches.map((batch) => batch.marker),
      ["small:0", "large:20", "small:6"],
    );
    assert.deepEqual(
      state.scheduler.shown
        .get("unit-0")
        .batches.map((batch) => batch.userData.sceneStream),
      cut.ranges.map((item) => ({
        unit: "unit-0",
        node: item.node,
        resource: item.source.url,
        start: item.start + 100,
      })),
    );
    assert.equal(state.scheduler.stats.visibleSplats, 6);
    assert.equal(state.scheduler.stats.visibleRegions, 3);
    assert.equal(state.scheduler.stats.shDegree, 1);
    assert.ok(Math.max(...state.samples) <= state.cpu);
    assert.equal(state.scheduler.stats.residentCpuBytes, regionCpu(cut));
    assert.deepEqual(state.errors, []);
  },
);

test(
  "overlapping nodes share one PLY decode and the pipeline awaits last-owner cache acknowledgement",
  { timeout: 3000 },
  async (context) => {
    const decode = deferred();
    const otherExtraction = deferred();
    const acknowledgement = deferred();
    let extractionStarted = false;
    let releaseStarted = false;
    const state = harness(context, {
      reps: [cut, shared],
      beforeLoad: (source) =>
        source.key === "large" ? decode.promise : undefined,
      beforeExtract: (source, ranges) => {
        if (source.key === "large" && ranges[0].start === 30) {
          extractionStarted = true;
          return otherExtraction.promise;
        }
      },
      beforeDispose: (source) => {
        if (source.key === "large") {
          releaseStarted = true;
          return acknowledgement.promise;
        }
      },
    });
    await state.scheduler.initialized;
    state.scheduler.update();
    await until(() => state.loads.length > 0);
    assert.equal(state.scheduler.jobs.size, 2);
    decode.resolve();
    await until(() => extractionStarted && state.batches.length > 0);
    assert.deepEqual(state.loads, ["large"]);
    assert.equal(releaseStarted, false);
    assert.ok(state.batches.every((batch) => !batch.visible));
    otherExtraction.resolve();
    await until(() => releaseStarted);
    assert.deepEqual(
      state.loads,
      ["large"],
      "the next file must not load before the shared cache acknowledgement",
    );
    assert.equal(state.scheduler.stats.visibleSplats, 0);
    acknowledgement.resolve();
    await until(
      () => state.scheduler.stats.loadProgress === 1,
      state.scheduler,
    );
    assert.deepEqual(state.loads, ["large", "small"]);
    assert.deepEqual(state.releases, ["large", "small"]);
    assert.equal(state.scheduler.stats.visibleSplats, 8);
    assert.deepEqual(state.errors, []);
    assert.ok(Math.max(...state.samples) <= state.cpu);
  },
);

for (const sameSource of [false, true]) {
  for (const outcome of ["success", "failure", "cancel"]) {
    test(
      `a ${sameSource ? "shared-source" : "multi-file"} replacement ${outcome} publishes atomically and releases its ownership`,
      { timeout: 3000 },
      async (context) => {
        const replacement = sameSource
          ? {
              id: "shared-cut",
              count: 8,
              ranges: [
                range(large, 0, 2, "first"),
                range(large, 2, 3, "second"),
                range(large, 5, 3, "last"),
              ],
            }
          : cut;
        const finalExtraction = deferred();
        let finalStarted = false;
        const state = harness(context, {
          reps: [parent],
          cpu:
            regionCpu(parent) +
            regionCpu(replacement) +
            sourceMemory(large) +
            65536,
          beforeExtract: (source, ranges) => {
            if (sameSource ? ranges[0].start === 5 : source.key === "small") {
              finalStarted = true;
              return finalExtraction.promise;
            }
          },
        });
        await state.scheduler.initialized;
        await until(
          () => state.scheduler.stats.loadProgress === 1,
          state.scheduler,
        );
        await state.scheduler.firstRenderable;
        assert.equal(state.scheduler.stats.visibleSplats, 1);
        const old = state.scheduler.shown.get("unit-0").batches[0];
        state.select([["unit-0", replacement]]);
        await until(() => finalStarted);
        assert.equal(old.visible, true);
        assert.equal(old.disposed, false);
        assert.equal(state.scheduler.shown.get("unit-0").rep.id, "parent");
        assert.ok(state.batches.slice(1).every((batch) => !batch.visible));
        const held = state.scheduler.stats.residentCpuBytes;
        if (outcome === "cancel") {
          state.select([["unit-0", parent]]);
          await tick();
          assert.equal(
            state.scheduler.stats.residentCpuBytes,
            held,
            "an in-flight extraction keeps its source lease and reservation",
          );
          assert.ok(state.live.has(sameSource ? "large" : "small"));
          finalExtraction.resolve();
        } else if (outcome === "failure") {
          finalExtraction.reject(new Error("Invalid final child"));
        } else finalExtraction.resolve();
        await until(() => !state.scheduler.jobs.size, state.scheduler);
        if (outcome === "success") {
          assert.equal(old.disposed, true);
          assert.equal(
            state.scheduler.shown.get("unit-0").rep.id,
            replacement.id,
          );
          assert.equal(state.scheduler.stats.visibleSplats, replacement.count);
          assert.ok(
            state.batches
              .slice(1)
              .every((batch) => batch.visible && !batch.disposed),
          );
          assert.equal(
            state.scheduler.stats.residentCpuBytes,
            regionCpu(replacement),
          );
        } else {
          state.scheduler.update();
          await tick();
          assert.equal(old.visible, true);
          assert.equal(old.disposed, false);
          assert.equal(state.scheduler.shown.get("unit-0").rep.id, "parent");
          assert.ok(
            state.batches
              .slice(1)
              .every((batch) => batch.disposed && !batch.visible),
          );
          assert.equal(
            state.scheduler.stats.residentCpuBytes,
            regionCpu(parent),
          );
        }
        assert.equal(state.live.size, 0);
        assert.equal(state.errors.length, outcome === "failure" ? 1 : 0);
        assert.ok(Math.max(...state.samples) <= state.cpu);
        state.scheduler.dispose();
        await tick();
        assert.equal(state.scheduler.stats.residentBytes, 0);
      },
    );
  }
}

for (const overlapFits of [true, false]) {
  test(
    `large Quality replacement ${overlapFits ? "publishes within default budgets" : "retains coarse coverage when overlap cannot fit"}`,
    { timeout: 3000 },
    async (context) => {
      const { model } = await readLccFixture(context, {
        counts: [0, 2671353, 1],
        offsets: [0, 173404352, 0],
        unit: 1,
      });
      const replacement = model.units[0].representations[1];
      const last = deferred();
      let finalStarted = false;
      const loadedCounts = [];
      const gpu = overlapFits
        ? 1024 ** 3
        : replacement.ranges.reduce(
            (sum, range) => sum + regionMemory(range.count, 3).gpu,
            0,
          );
      const state = harness(context, {
        model,
        policy: selectLccUnits,
        cpu: 2 * 1024 ** 3,
        gpu,
        beforeLoad: (source) => {
          loadedCounts.push(source.count);
        },
        beforeExtract: (source) => {
          if (source.count === 49913) {
            finalStarted = true;
            return last.promise;
          }
        },
      });
      await state.scheduler.initialized;
      await until(
        () => state.scheduler.stats.visibleSplats === 1,
        state.scheduler,
      );
      const old = state.scheduler.shown.get("1").batches[0];
      if (overlapFits) {
        await until(() => finalStarted, state.scheduler);
        assert.equal(old.visible, true);
        assert.equal(old.disposed, false);
        assert.ok(state.batches.slice(1).every((batch) => !batch.visible));
        last.resolve();
        await until(
          () => state.scheduler.stats.visibleSplats === 2671353,
          state.scheduler,
        );
        assert.equal(old.disposed, true);
        assert.equal(state.scheduler.shown.get("1").rep.id, "1:1");
        assert.equal(state.scheduler.stats.shDegree, 3);
        assert.equal(loadedCounts.length, 12);
        assert.ok(loadedCounts.every((count) => count <= 262144));
      } else {
        for (let update = 0; update < 10; update++) {
          state.scheduler.update();
          await tick();
        }
        assert.deepEqual(loadedCounts, [1]);
        assert.equal(state.scheduler.stats.visibleSplats, 1);
        assert.equal(old.visible, true);
        assert.equal(old.disposed, false);
      }
      assert.ok(Math.max(...state.samples) <= 2 * 1024 ** 3);
      assert.ok(state.scheduler.stats.residentGpuBytes <= gpu);
      assert.deepEqual(state.errors, []);
    },
  );
}

test(
  "temporary source admission waits for cache release without failure, and waiting owners can cancel",
  { timeout: 3000 },
  async () => {
    const acknowledgement = deferred();
    const memory = new SceneMemory(sourceMemory(large), 0);
    const loads = [];
    const sources = new SceneSources(
      async (source) => {
        loads.push(source.key);
        return {
          dispose: () =>
            source.key === "large" ? acknowledgement.promise : undefined,
        };
      },
      memory,
      new AbortController().signal,
    );
    const active = sources.acquire(large);
    await active.promise;
    const canceled = new AbortController();
    const rejected = sources.acquireWhenAvailable(small, canceled.signal);
    const next = sources.acquireWhenAvailable(
      small,
      new AbortController().signal,
    );
    canceled.abort();
    await assert.rejects(rejected, { name: "AbortError" });
    const release = active.release();
    assert.equal(
      active.release(),
      release,
      "release acknowledgement is idempotent",
    );
    await tick();
    assert.deepEqual(loads, ["large"]);
    assert.equal(memory.cpu, sourceMemory(large));
    acknowledgement.resolve();
    await release;
    const lease = await next;
    await lease.promise;
    assert.deepEqual(loads, ["large", "small"]);
    await lease.release();
    assert.equal(memory.cpu, 0);
    await sources.dispose();
  },
);

// RAD v1 encoding adapted from MIT-licensed code. See THIRD_PARTY_LICENSES.md.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { HALF, half, halfBits, opacityRadius } from "./math.js";
import { YOUNG_MB, encoders } from "./parallel.js";
import { SH_DIMS } from "./splats.js";
import { readAll, removePath, writeAll } from "./storage.js";

const CHUNK = 65536;
function header(magic, meta) {
  const json = Buffer.from(JSON.stringify(meta));
  const result = Buffer.alloc(8 + Math.ceil(json.length / 8) * 8);
  result.write(magic);
  result.writeUInt32LE(json.length, 4);
  json.copy(result, 8);
  return result;
}
function exists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function chunkStem(output) {
  const stem = path.basename(output, path.extname(output));
  // Keep the on-disk name usable as a relative URL and a resolveFile key.
  // Escape '=' too so distinct stems cannot produce the same chunk names.
  return Array.from(stem, (char) =>
    char <= " " || "\\%#?:=".includes(char)
      ? encodeURIComponent(char).replace("%", "=")
      : char,
  ).join("");
}
export function checkOutput(output, chunked) {
  if (path.extname(output).toLowerCase() !== ".rad")
    throw new Error("Output must have a .rad extension");
  if (exists(output)) throw new Error(`Output already exists: ${output}`);
  if (!statSync(path.dirname(output)).isDirectory())
    throw new Error("Output parent is not a directory");
  if (chunked) {
    const prefix = `${chunkStem(output)}-`;
    for (const name of readdirSync(path.dirname(output))) {
      if (
        name.startsWith(prefix) &&
        /^\d+\.radc$/.test(name.slice(prefix.length))
      )
        throw new Error(`Output chunk already exists: ${name}`);
    }
  }
}
class Histogram {
  constructor() {
    this.counts = new Float64Array(65536);
    this.count = 0;
  }
  // Adds the counts of a Histogram, also one copied from a worker.
  merge(other) {
    for (let i = 0; i < 65536; i++) this.counts[i] += other.counts[i];
    this.count += other.count;
  }
  add(bits) {
    this.counts[bits & 32768 ? bits ^ 65535 : bits ^ 32768]++;
    this.count++;
  }
  percentile(fraction) {
    let rank = Math.min(
      this.count - 1,
      Math.round(Math.fround(Math.fround(this.count) * Math.fround(fraction))),
    );
    for (let i = 0; i < 65536; i++) {
      if (rank < this.counts[i]) return HALF[i & 32768 ? i ^ 32768 : i ^ 65535];
      rank -= this.counts[i];
    }
    throw new Error("Empty encoding histogram");
  }
}
function alpha(value) {
  return value > 1
    ? half(Math.min(2, 1 + 0.25 * (opacityRadius(value) - 1)))
    : value;
}
// What the encoding ranges depend on, counted from gathered chunks.
class Counts {
  constructor() {
    this.colors = new Histogram();
    this.scales = new Histogram();
    this.sh = SH_DIMS.map(() => new Histogram());
    this.alphaF16 = false;
  }
  add(chunk) {
    const { records, count } = chunk;
    for (let i = 0; i < count; i++) {
      const offset = i * 16;
      this.alphaF16 ||= alpha(records[offset + 3]) > 1;
      for (let d = 4; d <= 6; d++)
        this.colors.add(halfBits(records[offset + d]));
      const a = records[offset + 7];
      const b = records[offset + 8];
      const c = records[offset + 9];
      this.scales.add(
        halfBits(Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))),
      );
      this.scales.add(halfBits(Math.max(a, b, c)));
    }
    for (let band = 0; band < chunk.sh.length; band++)
      for (const bits of chunk.sh[band]) this.sh[band].add(bits);
  }
  merge(other) {
    this.colors.merge(other.colors);
    this.scales.merge(other.scales);
    for (let band = 0; band < SH_DIMS.length; band++)
      this.sh[band].merge(other.sh[band]);
    this.alphaF16 ||= other.alphaF16;
  }
}

function encoding(counts, maxSh) {
  const { colors, scales } = counts;
  const rgbMin = Math.min(0, colors.percentile(0.01));
  const rgbMax = Math.max(1, colors.percentile(0.99));
  const lnScaleMin = Math.min(
    -12,
    Math.max(Math.log(1e-30), scales.percentile(0.01)),
  );
  const lnScaleMax = Math.max(9, scales.percentile(0.99));
  const limits = [1, 1, 1];
  for (let band = 0; band < maxSh; band++) {
    const histogram = counts.sh[band];
    limits[band] = Math.max(
      1,
      Math.abs(histogram.percentile(0.05)),
      Math.abs(histogram.percentile(0.95)),
    );
  }
  // The s8 code of each half value, per band.
  const sh = limits.map((limit) => {
    const codes = new Uint8Array(65536);
    for (let bits = 0; bits < 65536; bits++)
      codes[bits] =
        signedRound(Math.max(-127, Math.min(127, (HALF[bits] / limit) * 127))) &
        255;
    return codes;
  });
  return {
    alphaF16: counts.alphaF16,
    rgbF16: rgbMin < -1 || rgbMax > 2,
    sh,
    scaleF16: lnScaleMax - lnScaleMin > 25,
    limits,
    meta: {
      rgbMin,
      rgbMax,
      lnScaleMin,
      lnScaleMax,
      sh1Max: limits[0],
      sh2Max: limits[1],
      sh3Max: limits[2],
      lodOpacity: true,
    },
  };
}
const unorm = (value, min, max) =>
  Math.round(Math.max(0, Math.min(255, ((value - min) / (max - min)) * 255)));
const signedRound = (value) =>
  value < 0 ? -Math.round(-value) : Math.round(value);

// The columns of the splats from `base` on that encodeChunk() reads, and
// Counts without the children.
function gather(splats, base, count, children = true) {
  return {
    base,
    count,
    records: splats.records.read(base * 16, new Float32Array(count * 16)),
    sh: splats.sh
      .slice(0, splats.maxSh)
      .map((column, band) =>
        column.read(
          base * SH_DIMS[band],
          new Uint16Array(count * SH_DIMS[band]),
        ),
      ),
    ...(children && {
      counts: splats.childCount.read(base, new Uint32Array(count)),
      starts: splats.childStart.read(base, new Float64Array(count)),
    }),
  };
}

// Raw property bytes, reused: each property is compressed before the next.
const scratch = [Buffer.alloc(0), Buffer.alloc(0)];
function raw(size, slot = 0) {
  if (scratch[slot].length < size) scratch[slot] = Buffer.allocUnsafe(size);
  return scratch[slot].subarray(0, size);
}

function encodeChunk(chunk, encoding) {
  const { base, count, records } = chunk;
  const properties = [];
  const payloads = [];
  let payloadBytes = 0;
  // Compresses a property's bytes and appends them, padded to 8 bytes.
  const property = (name, codec, data, range) => {
    const bytes = deflateRawSync(data, { level: 6 });
    const padding = Buffer.alloc((8 - (bytes.length % 8)) % 8);
    properties.push({
      property: name,
      encoding: codec,
      compression: "gz",
      ...(range && { min: range[0], max: range[1] }),
      offset: payloadBytes,
      bytes: bytes.length,
    });
    payloads.push(bytes, padding);
    payloadBytes += bytes.length + padding.length;
  };
  const input = new Uint8Array(records.buffer);
  let bytes = raw(count * 12);
  for (let b = 0; b < 4; b++)
    for (let d = 0; d < 3; d++)
      for (let i = 0; i < count; i++)
        bytes[(b * 3 + d) * count + i] = input[i * 64 + d * 4 + b];
  property("center", "f32_lebytes", bytes);
  bytes = raw(count * (encoding.alphaF16 ? 2 : 1));
  for (let i = 0; i < count; i++) {
    const value = alpha(records[i * 16 + 3]);
    if (encoding.alphaF16) bytes.writeUInt16LE(halfBits(value), i * 2);
    else bytes[i] = unorm(value, 0, 2);
  }
  property(
    "alpha",
    encoding.alphaF16 ? "f16" : "r8",
    bytes,
    encoding.alphaF16 ? undefined : [0, 2],
  );
  bytes = raw(count * 3 * (encoding.rgbF16 ? 2 : 1));
  for (let d = 0; d < 3; d++) {
    let last = 0;
    for (let i = 0; i < count; i++) {
      const value = records[i * 16 + 4 + d];
      const offset = d * count + i;
      if (encoding.rgbF16) bytes.writeUInt16LE(halfBits(value), offset * 2);
      else {
        const code = unorm(value, encoding.meta.rgbMin, encoding.meta.rgbMax);
        bytes[offset] = (code - last) & 255;
        last = code;
      }
    }
  }
  property(
    "rgb",
    encoding.rgbF16 ? "f16" : "r8_delta",
    bytes,
    encoding.rgbF16 ? undefined : [encoding.meta.rgbMin, encoding.meta.rgbMax],
  );
  bytes = raw(count * 3 * (encoding.scaleF16 ? 2 : 1));
  for (let d = 0; d < 3; d++)
    for (let i = 0; i < count; i++) {
      const value = records[i * 16 + 7 + d];
      const offset = d * count + i;
      if (encoding.scaleF16) bytes.writeUInt16LE(halfBits(value), offset * 2);
      else
        bytes[offset] =
          value <= -30
            ? 0
            : 1 +
              Math.round(
                Math.max(
                  0,
                  Math.min(
                    254,
                    ((value - encoding.meta.lnScaleMin) /
                      (encoding.meta.lnScaleMax - encoding.meta.lnScaleMin)) *
                      254,
                  ),
                ),
              );
    }
  property(
    "scales",
    encoding.scaleF16 ? "ln_f16" : "ln_0r8",
    bytes,
    encoding.scaleF16
      ? undefined
      : [encoding.meta.lnScaleMin, encoding.meta.lnScaleMax],
  );
  bytes = raw(count * 3);
  for (let i = 0; i < count; i++) {
    const offset = i * 16;
    const sign = records[offset + 13] < 0 ? -1 : 1;
    const theta =
      2 * Math.acos(Math.max(0, Math.min(1, records[offset + 13] * sign)));
    const s = Math.sin(theta * 0.5);
    let x = Math.abs(s) < 1e-6 ? 1 : (records[offset + 10] * sign) / s;
    let y = Math.abs(s) < 1e-6 ? 0 : (records[offset + 11] * sign) / s;
    const z = Math.abs(s) < 1e-6 ? 0 : (records[offset + 12] * sign) / s;
    const sum = Math.abs(x) + Math.abs(y) + Math.abs(z);
    x /= sum;
    y /= sum;
    if (z < 0) {
      const old = x;
      x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
      y = (1 - Math.abs(old)) * (y >= 0 ? 1 : -1);
    }
    bytes[i * 3] = unorm(x, -1, 1);
    bytes[i * 3 + 1] = unorm(y, -1, 1);
    bytes[i * 3 + 2] = unorm(theta, 0, Math.PI);
  }
  property("orientation", "oct88r8", bytes);
  for (let band = 0; band < chunk.sh.length; band++) {
    const dims = SH_DIMS[band];
    const values = chunk.sh[band];
    const codes = encoding.sh[band];
    bytes = raw(count * dims);
    for (let d = 0; d < dims; d++)
      for (let i = 0; i < count; i++)
        bytes[d * count + i] = codes[values[i * dims + d]];
    property(`sh${band + 1}`, "s8", bytes, [
      -encoding.limits[band],
      encoding.limits[band],
    ]);
  }
  const counts = raw(count * 2);
  const starts = raw(count * 4, 1);
  for (let i = 0; i < count; i++) {
    const children = chunk.counts[i];
    counts.writeUInt16LE(children, i * 2);
    starts.writeUInt32LE(children ? chunk.starts[i] : 0, i * 4);
  }
  property("child_count", "u16", counts);
  property("child_start", "u32", starts);
  const meta = header("RADC", {
    version: 1,
    base,
    count,
    maxSh: chunk.sh.length,
    lodTree: true,
    splatEncoding: encoding.meta,
    payloadBytes,
    properties,
  });
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(payloadBytes));
  return Buffer.concat([meta, size, ...payloads]);
}

// Counts and encodes chunks; in workers, each answers in order.
class Coder {
  constructor() {
    this.counts = new Counts();
    this.format = undefined;
  }
  handle({ type, chunk, format }) {
    if (type === "count") this.counts.add(chunk);
    else if (type === "counts") return this.counts;
    else if (type === "format") this.format = format;
    else return encodeChunk(chunk, this.format);
    return true;
  }
}

// Spreads counting and encoding over worker threads.
class Encoder {
  // Encodes `chunks` with workers when there is more than one and the
  // workspace has room for them.
  constructor(workspace, chunks) {
    this.next = 0;
    this.coder = new Coder();
    this.workers = Array.from({ length: encoders(workspace, chunks) }, () => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { coder: true },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: YOUNG_MB,
        },
      });
      worker.unref();
      worker.waiting = [];
      worker.on("message", (result) => worker.waiting.shift().resolve(result));
      // A failed worker fails its pending and later requests.
      const fail = (error) => {
        worker.failed ??= error;
        for (const job of worker.waiting.splice(0)) job.reject(worker.failed);
      };
      worker.on("error", fail);
      worker.on("exit", (code) =>
        fail(new Error(`Encoding worker exited (${code})`)),
      );
      return worker;
    });
  }
  get size() {
    return this.workers.length;
  }
  request(worker, message, transfer = []) {
    if (!worker) return Promise.resolve(this.coder.handle(message));
    if (worker.failed) return Promise.reject(worker.failed);
    return new Promise((resolve, reject) => {
      worker.waiting.push({ resolve, reject });
      worker.postMessage(message, transfer);
    });
  }
  // Sends a gathered chunk to the next worker.
  send(type, chunk) {
    return this.request(
      this.workers[this.next++ % this.workers.length],
      { type, chunk },
      [
        chunk.records.buffer,
        ...chunk.sh.map((values) => values.buffer),
        ...(chunk.counts ? [chunk.counts.buffer, chunk.starts.buffer] : []),
      ],
    );
  }
  // Sends `message` to every worker, or to this thread's coder without any.
  broadcast(message) {
    const all = this.workers.length ? this.workers : [undefined];
    return Promise.all(all.map((worker) => this.request(worker, message)));
  }
  async counts() {
    const counts = new Counts();
    for (const result of await this.broadcast({ type: "counts" }))
      counts.merge(result);
    return counts;
  }
  use(format) {
    return this.broadcast({ type: "format", format });
  }
  async encode(chunk) {
    const bytes = await this.send("encode", chunk);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  }
  // Resolves once the workers have stopped and their memory is free.
  close() {
    return Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}

if (!isMainThread && workerData?.coder) {
  const coder = new Coder();
  parentPort.on("message", (message) => {
    const result = coder.handle(message);
    // The chunk's buffers would otherwise pile up to tens of MiB before the
    // collector frees them.
    gc();
    // A chunk with its own memory moves to the main thread without a copy.
    const own =
      result instanceof Uint8Array &&
      result.byteOffset === 0 &&
      result.byteLength === result.buffer.byteLength;
    parentPort.postMessage(result, own ? [result.buffer] : []);
  });
}

export async function writeRad(splats, output, chunked, lodBase) {
  const chunks = [];
  const stem = chunkStem(output);
  const spool = chunked ? undefined : splats.workspace.file();
  // Write every file completely before publishing chunks, then the header.
  // Publication uses separate renames, so interruption can leave final files.
  const staged = [];
  const created = [];
  const stage = (file, write) => {
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const fd = openSync(temporary, "wx");
    staged.push({ temporary, file });
    try {
      write(fd);
      fsyncSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {}
      throw error;
    }
    closeSync(fd);
  };
  let total = 0;
  const store = (bytes) => {
    if (chunked) {
      const filename = `${stem}-${chunks.length}.radc`;
      stage(path.join(path.dirname(output), filename), (fd) =>
        writeAll(fd, bytes, 0),
      );
      chunks.push({ offset: 0, bytes: bytes.length, filename });
    } else {
      writeAll(spool, bytes, total);
      chunks.push({ offset: total, bytes: bytes.length });
    }
    total += bytes.length;
  };
  // Gather the next chunks while workers encode earlier ones; store them in
  // order. A chunk's failure is thrown when its turn comes, not as an
  // unhandled rejection while an earlier chunk is awaited.
  const pending = [];
  const encoder = new Encoder(
    splats.workspace,
    Math.ceil(splats.length / CHUNK),
  );
  try {
    // Count the encoding ranges in a first pass.
    for (let base = 0; base < splats.length; base += CHUNK) {
      const counted = encoder.send(
        "count",
        gather(splats, base, Math.min(CHUNK, splats.length - base), false),
      );
      counted.catch(() => {});
      pending.push(counted);
      if (pending.length > encoder.size + 1) await pending.shift();
    }
    while (pending.length) await pending.shift();
    const format = encoding(await encoder.counts(), splats.maxSh);
    await encoder.use(format);
    for (let base = 0; base < splats.length; base += CHUNK) {
      const bytes = encoder.encode(
        gather(splats, base, Math.min(CHUNK, splats.length - base)),
      );
      bytes.catch(() => {});
      pending.push(bytes);
      if (pending.length > encoder.size + 1) store(await pending.shift());
    }
    while (pending.length) store(await pending.shift());
    const meta = header("RAD0", {
      version: 1,
      type: "gsplat",
      count: splats.length,
      maxSh: splats.maxSh,
      lodTree: true,
      chunkSize: CHUNK,
      allChunkBytes: total,
      chunks,
      splatEncoding: format.meta,
      comment: `Gaussian Splat Lite quality LOD (base ${lodBase})`,
    });
    stage(output, (fd) => {
      writeAll(fd, meta, 0);
      if (spool !== undefined) {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (let offset = 0; offset < total; offset += buffer.length) {
          const bytes = buffer.subarray(
            0,
            Math.min(buffer.length, total - offset),
          );
          readAll(spool, bytes, offset);
          writeAll(fd, bytes, meta.length + offset);
        }
      }
    });
    for (const { temporary, file } of staged) {
      // rename can replace an existing file, so reserve the name exclusively.
      const fd = openSync(file, "wx");
      created.push(file);
      closeSync(fd);
      renameSync(temporary, file);
    }
    return meta.length + total;
  } catch (error) {
    await Promise.allSettled(pending);
    for (const { temporary } of staged) removePath(temporary);
    for (const file of created) removePath(file);
    throw error;
  } finally {
    await encoder.close();
  }
}

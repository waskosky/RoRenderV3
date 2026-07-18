"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const { PNG_SIGNATURE } = require("../lib/png");
const { RenderSessionManager, projectionTransform } = require("../lib/render-session");

const REQUEST_DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function withManager(callback) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "rorender-session-test-"));
  const config = loadConfig({}, {
    outputDir,
    maxPixels: 64,
    maxChunkPixels: 8,
    maxSessions: 2,
    sessionTtlMs: 60_000,
  });
  try {
    await callback(new RenderSessionManager(config), outputDir);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

test("render session writes PNG and projection sidecar", async () => {
  await withManager(async (manager, outputDir) => {
    const created = manager.create({
      width: 2,
      height: 1,
      artifactName: "town-map",
      requestDigest: REQUEST_DIGEST,
      projection: {
        plane: "xz",
        north: "negative-z",
        bounds: { minX: -10, minZ: -20, maxX: 10, maxZ: 20 },
      },
    });
    assert.equal(created.requestDigest, REQUEST_DIGEST);
    assert.equal(manager.status(created.sessionId).requestDigest, REQUEST_DIGEST);
    const receipt = manager.append(created.sessionId, {
      offset: 0,
      pixels: [0x04030201, 0xfdfcfbfa],
    });
    assert.equal(receipt.progress, 1);

    const completed = await manager.complete(created.sessionId);
    assert.equal(completed.state, "complete");
    assert.match(completed.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.equal(completed.artifact.imageFileName.includes("/"), false);

    const png = await fs.readFile(path.join(outputDir, completed.artifact.imageFileName));
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    const manifest = JSON.parse(
      await fs.readFile(path.join(outputDir, completed.artifact.manifestFileName), "utf8"),
    );
    assert.equal(manifest.protocol, "rorender.v1");
    assert.equal(manifest.render.requestDigest, REQUEST_DIGEST);
    assert.equal(manifest.image.sha256, completed.artifact.sha256);
    assert.deepEqual(manifest.projection.bounds, { minX: -10, minZ: -20, maxX: 10, maxZ: 20 });
    assert.equal(manifest.worldToPixel.coefficients.xScale, 0.05);
    assert.equal(manifest.worldToPixel.coefficients.zScale, 0);
  });
});

test("chunks are bounded and strictly contiguous", async () => {
  await withManager(async (manager) => {
    const created = manager.create({ width: 2, height: 2 });
    assert.throws(
      () => manager.append(created.sessionId, { offset: 1, pixels: [1] }),
      (error) => error.code === "NON_CONTIGUOUS_CHUNK" && error.details.expectedOffset === 0,
    );
    manager.append(created.sessionId, { offset: 0, pixels: [1, 2] });
    assert.throws(
      () => manager.append(created.sessionId, { offset: 2, pixels: [1, 2, 3] }),
      (error) => error.code === "TOO_MANY_PIXELS",
    );
    await assert.rejects(
      () => manager.complete(created.sessionId),
      (error) => error.code === "INCOMPLETE_RENDER",
    );
  });
});

test("artifact names and render dimensions cannot become paths or memory abuse", async () => {
  await withManager(async (manager) => {
    assert.throws(
      () => manager.create({ width: 1, height: 1, artifactName: "../../escape" }),
      (error) => error.code === "INVALID_ARTIFACT_NAME",
    );
    assert.throws(
      () => manager.create({ width: 65, height: 1 }),
      (error) => error.code === "IMAGE_TOO_LARGE",
    );
    assert.throws(
      () => manager.create({ width: "1", height: 1 }),
      (error) => error.code === "INVALID_RENDER_REQUEST",
    );
  });
});

test("request bindings reject malformed digests while omitted bindings remain compatible", async () => {
  await withManager(async (manager) => {
    for (const requestDigest of [null, "a".repeat(63), "A".repeat(64), `sha256:${"a".repeat(64)}`]) {
      assert.throws(
        () => manager.create({ width: 1, height: 1, requestDigest }),
        (error) => error.code === "INVALID_REQUEST_DIGEST",
      );
    }

    const created = manager.create({ width: 1, height: 1 });
    assert.equal(Object.hasOwn(created, "requestDigest"), false);
    manager.append(created.sessionId, { offset: 0, pixels: [0xffffffff] });
    await manager.complete(created.sessionId);
    assert.equal(Object.hasOwn(manager.getManifest(created.sessionId).render, "requestDigest"), false);
  });
});

test("projection transform supports either north orientation", () => {
  const bounds = { minX: 0, minZ: 10, maxX: 100, maxZ: 30 };
  const negative = projectionTransform({ bounds, north: "negative-z" }, 101, 21);
  assert.deepEqual(negative.coefficients, { xScale: 1, xOffset: 0, zScale: 1, zOffset: -10 });
  const positive = projectionTransform({ bounds, north: "positive-z" }, 101, 21);
  assert.deepEqual(positive.coefficients, { xScale: 1, xOffset: 0, zScale: -1, zOffset: 30 });
});

test("advisory observers cannot corrupt authoritative render state", async () => {
  await withManager(async (manager) => {
    manager.on("created", () => {
      throw new Error("preview failed");
    });
    manager.on("complete", () => {
      throw new Error("preview failed");
    });
    const created = manager.create({ width: 1, height: 1 });
    manager.append(created.sessionId, { offset: 0, pixels: [0xffffffff] });
    const completed = await manager.complete(created.sessionId);
    assert.equal(completed.state, "complete");
  });
});

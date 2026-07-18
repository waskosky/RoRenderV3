"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const { PNG_SIGNATURE } = require("../lib/png");
const { createRenderServer } = require("../lib/server");

async function withServer(options, callback) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "rorender-server-test-"));
  const config = loadConfig({}, {
    host: "127.0.0.1",
    port: 0,
    allowEphemeralPort: true,
    outputDir,
    maxPixels: 64,
    maxChunkPixels: 8,
    maxSessions: 4,
    sessionTtlMs: 60_000,
    ...options,
  });
  const provider = createRenderServer(config);
  const address = await provider.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback({ baseUrl, config, outputDir, provider });
  } finally {
    await provider.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

test("v1 HTTP lifecycle exposes compact receipts and completed image", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const health = await json(await fetch(`${baseUrl}/v1/health`));
    assert.equal(health.response.status, 200);
    assert.equal(health.body.protocol, "rorender.v1");

    const capabilities = await json(await fetch(`${baseUrl}/v1/capabilities`));
    assert.equal(capabilities.body.pixelEncoding.id, "packed-rgba-u32-le");

    const created = await json(await fetch(`${baseUrl}/v1/renders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 2, height: 1, artifactName: "api-map" }),
    }));
    assert.equal(created.response.status, 201);
    const sessionId = created.body.sessionId;

    const appended = await json(await fetch(`${baseUrl}/v1/renders/${sessionId}/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: 0, pixels: [0xff0000ff, 0xffffffff] }),
    }));
    assert.equal(appended.response.status, 202);
    assert.equal(appended.body.receivedPixels, 2);

    const completed = await json(await fetch(`${baseUrl}/v1/renders/${sessionId}/complete`, {
      method: "POST",
    }));
    assert.equal(completed.body.state, "complete");
    const imageResponse = await fetch(`${baseUrl}/v1/renders/${sessionId}/image`);
    const image = Buffer.from(await imageResponse.arrayBuffer());
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(image.subarray(0, 8), PNG_SIGNATURE);
    const manifest = await json(await fetch(`${baseUrl}/v1/renders/${sessionId}/manifest`));
    assert.equal(manifest.body.protocol, "rorender.v1");
    assert.equal(manifest.body.image.sha256, completed.body.artifact.sha256);

    const deleted = await fetch(`${baseUrl}/v1/renders/${sessionId}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
  });
});

test("bearer authentication protects capabilities and render routes", async () => {
  await withServer({ authToken: "this-is-a-long-test-auth-token" }, async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/v1/health`)).status, 200);
    const denied = await json(await fetch(`${baseUrl}/v1/capabilities`));
    assert.equal(denied.response.status, 401);
    assert.equal(denied.body.error.code, "UNAUTHORIZED");
    const admitted = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { authorization: "Bearer this-is-a-long-test-auth-token" },
    });
    assert.equal(admitted.status, 200);
  });
});

test("legacy V3 endpoint adapter produces a durable artifact", async () => {
  await withServer({ legacyEnabled: true }, async ({ baseUrl, outputDir }) => {
    const begun = await json(await fetch(`${baseUrl}/render-begin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageSize: { x: 1, y: 1 } }),
    }));
    assert.equal(begun.body.protocol, "legacy-v3");
    const chunk = await fetch(`${baseUrl}/data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([0xffffffff]),
    });
    assert.equal(chunk.status, 202);
    const done = await json(await fetch(`${baseUrl}/render-done`, { method: "POST" }));
    assert.equal(done.body.state, "complete");
    const files = await fs.readdir(outputDir);
    assert.equal(files.filter((file) => file.endsWith(".png")).length, 1);
    assert.equal(files.filter((file) => file.endsWith(".map.json")).length, 1);
  });
});

test("invalid and non-contiguous input has stable machine-readable errors", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const created = await json(await fetch(`${baseUrl}/v1/renders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 2, height: 1 }),
    }));
    const response = await json(await fetch(`${baseUrl}/v1/renders/${created.body.sessionId}/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: 1, pixels: [1] }),
    }));
    assert.equal(response.response.status, 409);
    assert.equal(response.body.error.code, "NON_CONTIGUOUS_CHUNK");
    assert.equal(response.body.error.details.expectedOffset, 0);
  });
});

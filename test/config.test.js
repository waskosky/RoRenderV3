"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { isLoopbackHost, loadConfig } = require("../lib/config");

test("configuration defaults to loopback and legacy compatibility", () => {
  const config = loadConfig({}, { outputDir: "relative-output" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8081);
  assert.equal(config.legacyEnabled, true);
  assert.equal(config.authToken, "");
  assert.equal(config.outputDir, path.resolve("relative-output"));
});

test("non-loopback binding requires a substantial bearer token", () => {
  assert.throws(
    () => loadConfig({}, { host: "0.0.0.0" }),
    (error) => error.code === "REMOTE_BIND_REQUIRES_AUTH",
  );
  assert.throws(
    () => loadConfig({}, { host: "0.0.0.0", authToken: "short" }),
    (error) => error.code === "REMOTE_BIND_REQUIRES_AUTH",
  );
  const config = loadConfig({}, {
    host: "0.0.0.0",
    authToken: "a-secure-test-token-with-entropy",
  });
  assert.equal(config.legacyEnabled, false);
  assert.equal(config.authToken, "a-secure-test-token-with-entropy");
});

test("loopback host recognition is explicit", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.2"), false);
});

test("PNG compression is configurable only within the supported range", () => {
  assert.equal(loadConfig({}, { pngCompression: 0 }).pngCompression, 0);
  assert.equal(loadConfig({}, { pngCompression: 9 }).pngCompression, 9);
  assert.throws(
    () => loadConfig({}, { pngCompression: 10 }),
    (error) => error.code === "INVALID_CONFIGURATION",
  );
});

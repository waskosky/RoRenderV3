#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const protocolSchema = JSON.parse(
  fs.readFileSync(path.join(root, "protocol", "rorender-v1.schema.json"), "utf8"),
);

assert.equal(packageJson.author, "A.J. Steinhauser", "Original author attribution must remain");
assert.equal(packageJson.license, "MIT", "Original MIT metadata must remain");
assert.equal(fs.existsSync(path.join(root, "LICENSE")), true, "LICENSE is required");
assert.equal(protocolSchema.$defs.createRender.type, "object", "Protocol schema must expose createRender");
assert.equal(protocolSchema.$defs.pixelChunk.type, "object", "Protocol schema must expose pixelChunk");
assert.equal(protocolSchema.$defs.mapManifest.type, "object", "Protocol schema must expose mapManifest");
assert.equal(
  protocolSchema.$defs.requestDigest.pattern,
  "^[0-9a-f]{64}$",
  "Protocol schema must constrain requestDigest to lowercase SHA-256 hex",
);
for (const digestProperty of [
  protocolSchema.$defs.createRender.properties.requestDigest,
  protocolSchema.$defs.renderStatus.properties.requestDigest,
  protocolSchema.$defs.mapManifest.properties.render.properties.requestDigest,
]) {
  assert.equal(
    digestProperty.$ref,
    "#/$defs/requestDigest",
    "Protocol request bindings must share the canonical requestDigest definition",
  );
}

const forbiddenRuntimePackages = [
  "body-parser",
  "express",
  "fastify",
  "fs",
  "jimp",
  "jquery",
  "path",
  "tmp",
  "url",
];
for (const name of forbiddenRuntimePackages) {
  assert.equal(packageJson.dependencies[name], undefined, `${name} must not be a runtime dependency`);
}

const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
assert.match(mainSource, /contextIsolation:\s*true/, "Electron context isolation must remain enabled");
assert.match(mainSource, /nodeIntegration:\s*false/, "Electron Node integration must remain disabled");
assert.match(mainSource, /sandbox:\s*true/, "Electron renderer sandbox must remain enabled");

const sourceFiles = [
  "main.js",
  "preload.js",
  "renderer.js",
  "bin/rorender.js",
  ...fs.readdirSync(path.join(root, "lib")).filter((name) => name.endsWith(".js")).map((name) => `lib/${name}`),
];
for (const relativePath of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${relativePath} failed syntax validation: ${result.stderr}`);
}

process.stdout.write(`Validated ${sourceFiles.length} JavaScript files and protocol metadata.\n`);

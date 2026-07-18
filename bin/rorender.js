#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadConfig, publicConfig } = require("../lib/config");
const { createRenderServer } = require("../lib/server");

function usage() {
  return `RoRenderV3 headless provider

Usage:
  rorender serve [options]
  rorender doctor [options]

Options:
  --host <host>          Bind host (default: 127.0.0.1)
  --port <port>          Bind port (default: 8081)
  --output-dir <path>    Artifact directory (default: ./renders)
  --max-pixels <count>   Maximum pixels per render
  --legacy               Enable legacy V3 endpoints
  --no-legacy            Disable legacy V3 endpoints
  --help                  Show this help

Security:
  Set RORENDER_AUTH_TOKEN to a random value of at least 24 characters before
  binding to a non-loopback host. Tokens are intentionally not accepted as CLI
  arguments because process arguments may be visible to other users.
`;
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--legacy") {
      options.legacyEnabled = true;
      continue;
    }
    if (argument === "--no-legacy") {
      options.legacyEnabled = false;
      continue;
    }
    const keyByFlag = {
      "--host": "host",
      "--port": "port",
      "--output-dir": "outputDir",
      "--max-pixels": "maxPixels",
    };
    const key = keyByFlag[argument];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = argumentsList[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function doctor(config) {
  await fs.mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  const probePath = path.join(config.outputDir, `.rorender-write-probe-${crypto.randomUUID()}`);
  await fs.writeFile(probePath, "ok", { mode: 0o600, flag: "wx" });
  await fs.unlink(probePath);
  process.stdout.write(`${JSON.stringify({ status: "ready", config: publicConfig(config) })}\n`);
}

async function serve(config) {
  const provider = createRenderServer(config);
  const address = await provider.listen();
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  process.stdout.write(`${JSON.stringify({
    event: "ready",
    protocol: "rorender.v1",
    url: `http://${displayHost}:${address.port}`,
    outputDir: config.outputDir,
    authentication: config.authToken ? "bearer" : "loopback-only",
  })}\n`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    await provider.close();
    process.stdout.write(`${JSON.stringify({ event: "stopped", signal })}\n`);
  };
  process.once("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));
}

async function main() {
  const [command = "serve", ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (command !== "serve" && command !== "doctor") throw new Error(`Unknown command: ${command}`);
  const overrides = parseArguments(rest);
  if (overrides.help) {
    process.stdout.write(usage());
    return;
  }
  const config = loadConfig(process.env, overrides);
  if (command === "doctor") await doctor(config);
  else await serve(config);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: error.code ?? "STARTUP_FAILED",
      message: error.message,
    },
  })}\n`);
  process.exitCode = 1;
});

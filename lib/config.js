"use strict";

const path = require("node:path");
const { ProtocolError } = require("./errors");

const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 8081,
  maxPixels: 16_777_216,
  maxChunkPixels: 262_144,
  maxBodyBytes: 4 * 1024 * 1024,
  maxSessions: 4,
  sessionTtlMs: 15 * 60 * 1000,
  pngCompression: 6,
});

function parseInteger(value, fallback, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProtocolError(
      "INVALID_CONFIGURATION",
      `${name} must be an integer between ${minimum} and ${maximum}`,
      500,
    );
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new ProtocolError("INVALID_CONFIGURATION", `Invalid boolean value: ${value}`, 500);
}

function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function loadConfig(env = process.env, overrides = {}) {
  const host = overrides.host ?? env.RORENDER_HOST ?? DEFAULTS.host;
  const port = parseInteger(overrides.port ?? env.RORENDER_PORT, DEFAULTS.port, "port", {
    minimum: overrides.allowEphemeralPort ? 0 : 1,
    maximum: 65_535,
  });
  const authToken = overrides.authToken ?? env.RORENDER_AUTH_TOKEN ?? "";
  const remote = !isLoopbackHost(host);

  if (remote && authToken.length < 24) {
    throw new ProtocolError(
      "REMOTE_BIND_REQUIRES_AUTH",
      "Non-loopback binding requires RORENDER_AUTH_TOKEN with at least 24 characters",
      500,
    );
  }

  const outputDir = path.resolve(
    overrides.outputDir ?? env.RORENDER_OUTPUT_DIR ?? path.join(process.cwd(), "renders"),
  );

  return Object.freeze({
    host,
    port,
    outputDir,
    authToken,
    legacyEnabled: parseBoolean(
      overrides.legacyEnabled ?? env.RORENDER_LEGACY_ENABLED,
      !remote,
    ),
    maxPixels: parseInteger(
      overrides.maxPixels ?? env.RORENDER_MAX_PIXELS,
      DEFAULTS.maxPixels,
      "maxPixels",
    ),
    maxChunkPixels: parseInteger(
      overrides.maxChunkPixels ?? env.RORENDER_MAX_CHUNK_PIXELS,
      DEFAULTS.maxChunkPixels,
      "maxChunkPixels",
    ),
    maxBodyBytes: parseInteger(
      overrides.maxBodyBytes ?? env.RORENDER_MAX_BODY_BYTES,
      DEFAULTS.maxBodyBytes,
      "maxBodyBytes",
    ),
    maxSessions: parseInteger(
      overrides.maxSessions ?? env.RORENDER_MAX_SESSIONS,
      DEFAULTS.maxSessions,
      "maxSessions",
    ),
    sessionTtlMs: parseInteger(
      overrides.sessionTtlMs ?? env.RORENDER_SESSION_TTL_MS,
      DEFAULTS.sessionTtlMs,
      "sessionTtlMs",
      { minimum: 1_000 },
    ),
    pngCompression: parseInteger(
      overrides.pngCompression ?? env.RORENDER_PNG_COMPRESSION,
      DEFAULTS.pngCompression,
      "pngCompression",
      { minimum: 0, maximum: 9 },
    ),
  });
}

function publicConfig(config) {
  return {
    host: config.host,
    port: config.port,
    outputDir: config.outputDir,
    authentication: config.authToken ? "bearer" : "loopback-only",
    legacyEnabled: config.legacyEnabled,
    limits: {
      maxPixels: config.maxPixels,
      maxChunkPixels: config.maxChunkPixels,
      maxBodyBytes: config.maxBodyBytes,
      maxSessions: config.maxSessions,
      sessionTtlMs: config.sessionTtlMs,
      pngCompression: config.pngCompression,
    },
  };
}

module.exports = { DEFAULTS, isLoopbackHost, loadConfig, publicConfig };

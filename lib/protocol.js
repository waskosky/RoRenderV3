"use strict";

const PROTOCOL_VERSION = "rorender.v1";
const PIXEL_ENCODING = "packed-rgba-u32-le";

function capabilities(config) {
  return {
    protocol: PROTOCOL_VERSION,
    service: "RoRenderV3 Headless Provider",
    transport: "http-json",
    pixelEncoding: {
      id: PIXEL_ENCODING,
      description: "One unsigned 32-bit integer per pixel: R in bits 0-7, G in 8-15, B in 16-23, A in 24-31",
      chunkOrdering: "strictly-contiguous",
    },
    projection: {
      plane: "xz",
      pixelOrigin: "top-left",
      northOptions: ["negative-z", "positive-z"],
      sidecarManifest: true,
    },
    requestBinding: {
      createField: "requestDigest",
      algorithm: "sha256",
      encoding: "lowercase-hex",
      statusEcho: true,
      manifestPath: "render.requestDigest",
      optional: true,
    },
    endpoints: {
      create: "POST /v1/renders",
      append: "POST /v1/renders/{sessionId}/chunks",
      complete: "POST /v1/renders/{sessionId}/complete",
      status: "GET /v1/renders/{sessionId}",
      image: "GET /v1/renders/{sessionId}/image",
      manifest: "GET /v1/renders/{sessionId}/manifest",
      delete: "DELETE /v1/renders/{sessionId}",
    },
    compatibility: {
      legacyV3: config.legacyEnabled,
      endpoints: config.legacyEnabled
        ? ["POST /render-begin", "POST /data", "POST /render-done"]
        : [],
    },
    limits: {
      maxPixels: config.maxPixels,
      maxChunkPixels: config.maxChunkPixels,
      maxBodyBytes: config.maxBodyBytes,
      maxSessions: config.maxSessions,
      pngCompression: config.pngCompression,
    },
  };
}

module.exports = { PIXEL_ENCODING, PROTOCOL_VERSION, capabilities };

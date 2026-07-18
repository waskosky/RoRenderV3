"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { ProtocolError } = require("./errors");
const { encodePngAsync } = require("./png");
const { PIXEL_ENCODING, PROTOCOL_VERSION } = require("./protocol");

const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolError("INVALID_RENDER_REQUEST", `${name} must be a positive integer`);
  }
  return value;
}

function validateProjection(projection) {
  if (projection === undefined || projection === null) return null;
  if (typeof projection !== "object" || Array.isArray(projection)) {
    throw new ProtocolError("INVALID_PROJECTION", "projection must be an object");
  }
  if (projection.plane !== undefined && projection.plane !== "xz") {
    throw new ProtocolError("INVALID_PROJECTION", "Only the Roblox xz projection plane is supported");
  }
  const bounds = projection.bounds;
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new ProtocolError("INVALID_PROJECTION", "projection.bounds is required");
  }
  const normalized = {};
  for (const key of ["minX", "minZ", "maxX", "maxZ"]) {
    const value = bounds[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ProtocolError("INVALID_PROJECTION", `projection.bounds.${key} must be finite`);
    }
    normalized[key] = value;
  }
  if (normalized.maxX <= normalized.minX || normalized.maxZ <= normalized.minZ) {
    throw new ProtocolError("INVALID_PROJECTION", "projection bounds must have positive x and z spans");
  }
  const north = projection.north ?? "negative-z";
  if (north !== "negative-z" && north !== "positive-z") {
    throw new ProtocolError("INVALID_PROJECTION", "projection.north must be negative-z or positive-z");
  }
  return { plane: "xz", bounds: normalized, north, pixelOrigin: "top-left" };
}

function projectionTransform(projection, width, height) {
  if (!projection) return null;
  const { bounds, north } = projection;
  const xScale = (width - 1) / (bounds.maxX - bounds.minX);
  const zMagnitude = (height - 1) / (bounds.maxZ - bounds.minZ);
  const zScale = north === "negative-z" ? zMagnitude : -zMagnitude;
  const zOffset = north === "negative-z" ? -bounds.minZ * zMagnitude : bounds.maxZ * zMagnitude;
  const canonicalNumber = (value) => (Object.is(value, -0) ? 0 : value);
  return {
    formula: {
      pixelX: "x * xScale + xOffset",
      pixelY: "z * zScale + zOffset",
    },
    coefficients: {
      xScale: canonicalNumber(xScale),
      xOffset: canonicalNumber(-bounds.minX * xScale),
      zScale: canonicalNumber(zScale),
      zOffset: canonicalNumber(zOffset),
    },
  };
}

class RenderSession {
  constructor({ id, width, height, artifactName, projection, requestDigest, now }) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.pixelCount = width * height;
    this.artifactName = artifactName;
    this.projection = projection;
    this.requestDigest = requestDigest;
    this.rgba = Buffer.alloc(this.pixelCount * 4);
    this.nextOffset = 0;
    this.state = "receiving";
    this.createdAt = now;
    this.updatedAt = now;
    this.artifact = null;
    this.manifest = null;
    this.error = null;
  }

  append(values, offset, maxChunkPixels, now) {
    if (this.state !== "receiving") {
      throw new ProtocolError("SESSION_NOT_RECEIVING", `Session is ${this.state}`, 409);
    }
    if (!Array.isArray(values) || values.length < 1) {
      throw new ProtocolError("INVALID_PIXEL_CHUNK", "pixels must be a non-empty array");
    }
    if (values.length > maxChunkPixels) {
      throw new ProtocolError(
        "PIXEL_CHUNK_TOO_LARGE",
        `Chunk exceeds the ${maxChunkPixels} pixel limit`,
        413,
      );
    }
    const normalizedOffset = offset === undefined ? this.nextOffset : offset;
    if (!Number.isSafeInteger(normalizedOffset) || normalizedOffset !== this.nextOffset) {
      throw new ProtocolError(
        "NON_CONTIGUOUS_CHUNK",
        `Expected chunk offset ${this.nextOffset}`,
        409,
        { expectedOffset: this.nextOffset },
      );
    }
    if (normalizedOffset + values.length > this.pixelCount) {
      throw new ProtocolError("TOO_MANY_PIXELS", "Chunk exceeds the declared image size", 409);
    }

    for (let index = 0; index < values.length; index += 1) {
      const rawValue = values[index];
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || !Number.isInteger(rawValue)) {
        throw new ProtocolError("INVALID_PIXEL_VALUE", `Pixel ${index} is not an integer`);
      }
      const packed = rawValue >>> 0;
      const byteOffset = (normalizedOffset + index) * 4;
      this.rgba[byteOffset] = packed & 0xff;
      this.rgba[byteOffset + 1] = (packed >>> 8) & 0xff;
      this.rgba[byteOffset + 2] = (packed >>> 16) & 0xff;
      this.rgba[byteOffset + 3] = (packed >>> 24) & 0xff;
    }

    this.nextOffset += values.length;
    this.updatedAt = now;
    return { offset: normalizedOffset, count: values.length };
  }

  status() {
    return {
      sessionId: this.id,
      state: this.state,
      imageSize: { width: this.width, height: this.height },
      pixelEncoding: PIXEL_ENCODING,
      receivedPixels: this.nextOffset,
      totalPixels: this.pixelCount,
      progress: this.pixelCount === 0 ? 0 : this.nextOffset / this.pixelCount,
      projection: this.projection,
      ...(this.requestDigest === undefined ? {} : { requestDigest: this.requestDigest }),
      artifact: this.artifact,
      error: this.error,
      createdAt: new Date(this.createdAt).toISOString(),
      updatedAt: new Date(this.updatedAt).toISOString(),
    };
  }
}

class RenderSessionManager extends EventEmitter {
  constructor(config, { clock = () => Date.now() } = {}) {
    super();
    this.config = config;
    this.clock = clock;
    this.sessions = new Map();
  }

  notify(eventName, payload) {
    for (const listener of this.rawListeners(eventName)) {
      try {
        listener.call(this, payload);
      } catch {
        // Rendering receipts and artifacts are authoritative; observers are advisory.
      }
    }
  }

  pruneExpired() {
    const cutoff = this.clock() - this.config.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.state !== "writing" && session.updatedAt < cutoff) {
        this.sessions.delete(id);
        this.notify("expired", { sessionId: id });
      }
    }
  }

  create({ width, height, artifactName, projection, requestDigest } = {}) {
    this.pruneExpired();
    const normalizedWidth = positiveInteger(width, "width");
    const normalizedHeight = positiveInteger(height, "height");
    const pixelCount = normalizedWidth * normalizedHeight;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > this.config.maxPixels) {
      throw new ProtocolError(
        "IMAGE_TOO_LARGE",
        `Image exceeds the ${this.config.maxPixels} pixel limit`,
        413,
      );
    }
    if (this.sessions.size >= this.config.maxSessions) {
      throw new ProtocolError("SESSION_LIMIT_REACHED", "Too many retained render sessions", 429);
    }
    const normalizedArtifactName = artifactName ?? "map";
    if (typeof normalizedArtifactName !== "string" || !ARTIFACT_NAME_PATTERN.test(normalizedArtifactName)) {
      throw new ProtocolError(
        "INVALID_ARTIFACT_NAME",
        "artifactName must contain only letters, numbers, underscores, or hyphens (maximum 64 characters)",
      );
    }
    if (requestDigest !== undefined && (
      typeof requestDigest !== "string" || !REQUEST_DIGEST_PATTERN.test(requestDigest)
    )) {
      throw new ProtocolError(
        "INVALID_REQUEST_DIGEST",
        "requestDigest must be a 64-character lowercase hexadecimal SHA-256 digest",
      );
    }

    const now = this.clock();
    const session = new RenderSession({
      id: crypto.randomUUID(),
      width: normalizedWidth,
      height: normalizedHeight,
      artifactName: normalizedArtifactName,
      projection: validateProjection(projection),
      requestDigest,
      now,
    });
    this.sessions.set(session.id, session);
    this.notify("created", session.status());
    return session.status();
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new ProtocolError("SESSION_NOT_FOUND", "Render session not found", 404);
    return session;
  }

  status(id) {
    return this.get(id).status();
  }

  append(id, { offset, pixels } = {}) {
    const session = this.get(id);
    const receipt = session.append(pixels, offset, this.config.maxChunkPixels, this.clock());
    const chunkReceipt = {
      sessionId: id,
      state: session.state,
      ...receipt,
      receivedPixels: session.nextOffset,
      totalPixels: session.pixelCount,
      nextOffset: session.nextOffset,
      progress: session.nextOffset / session.pixelCount,
    };
    this.notify("chunk", { ...chunkReceipt, pixels });
    return chunkReceipt;
  }

  async complete(id) {
    const session = this.get(id);
    if (session.state === "complete") return session.status();
    if (session.state !== "receiving") {
      throw new ProtocolError("SESSION_NOT_RECEIVING", `Session is ${session.state}`, 409);
    }
    if (session.nextOffset !== session.pixelCount) {
      throw new ProtocolError(
        "INCOMPLETE_RENDER",
        `Render has ${session.nextOffset} of ${session.pixelCount} pixels`,
        409,
        { receivedPixels: session.nextOffset, totalPixels: session.pixelCount },
      );
    }

    session.state = "writing";
    session.updatedAt = this.clock();
    const cleanupPaths = [];
    try {
      const png = await encodePngAsync({
        width: session.width,
        height: session.height,
        rgba: session.rgba,
        compressionLevel: this.config.pngCompression,
      });
      const sha256 = crypto.createHash("sha256").update(png).digest("hex");
      const stem = `${session.artifactName}-${session.id}`;
      const imageFileName = `${stem}.png`;
      const manifestFileName = `${stem}.map.json`;
      const imagePath = path.join(this.config.outputDir, imageFileName);
      const manifestPath = path.join(this.config.outputDir, manifestFileName);
      const temporaryImagePath = path.join(this.config.outputDir, `.${imageFileName}.tmp`);
      const temporaryManifestPath = path.join(this.config.outputDir, `.${manifestFileName}.tmp`);
      cleanupPaths.push(temporaryImagePath, temporaryManifestPath, imagePath, manifestPath);
      const completedAt = new Date(this.clock()).toISOString();
      const manifest = {
        schemaVersion: 1,
        protocol: PROTOCOL_VERSION,
        render: {
          sessionId: session.id,
          artifactName: session.artifactName,
          ...(session.requestDigest === undefined ? {} : { requestDigest: session.requestDigest }),
        },
        image: {
          fileName: imageFileName,
          mediaType: "image/png",
          width: session.width,
          height: session.height,
          bytes: png.length,
          sha256,
        },
        projection: session.projection,
        worldToPixel: projectionTransform(session.projection, session.width, session.height),
        completedAt,
      };

      await fs.mkdir(this.config.outputDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporaryImagePath, png, { mode: 0o600, flag: "wx" });
      await fs.writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporaryImagePath, imagePath);
      await fs.rename(temporaryManifestPath, manifestPath);

      session.state = "complete";
      session.updatedAt = this.clock();
      session.artifact = {
        imageFileName,
        manifestFileName,
        mediaType: "image/png",
        bytes: png.length,
        sha256,
      };
      session.manifest = manifest;
      session.rgba = null;
      this.notify("complete", { sessionId: id, status: session.status(), image: png, manifest });
      return session.status();
    } catch (error) {
      await Promise.allSettled(cleanupPaths.map((filePath) => fs.unlink(filePath)));
      session.state = "error";
      session.updatedAt = this.clock();
      session.error = { code: "ARTIFACT_WRITE_FAILED", message: "Could not write render artifacts" };
      this.notify("session-error", { sessionId: id, error });
      throw error;
    }
  }

  getImage(id) {
    const session = this.get(id);
    if (session.state !== "complete" || !session.artifact) {
      throw new ProtocolError("RENDER_NOT_COMPLETE", "Rendered image is not available", 409);
    }
    return fs.readFile(path.join(this.config.outputDir, session.artifact.imageFileName));
  }

  getManifest(id) {
    const session = this.get(id);
    if (session.state !== "complete" || !session.manifest) {
      throw new ProtocolError("RENDER_NOT_COMPLETE", "Map manifest is not available", 409);
    }
    return session.manifest;
  }

  delete(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ProtocolError("SESSION_NOT_FOUND", "Render session not found", 404);
    }
    if (session.state === "writing") {
      throw new ProtocolError("SESSION_WRITE_IN_PROGRESS", "Cannot release a session while artifacts are writing", 409);
    }
    this.sessions.delete(id);
  }
}

module.exports = {
  ARTIFACT_NAME_PATTERN,
  REQUEST_DIGEST_PATTERN,
  RenderSessionManager,
  projectionTransform,
  validateProjection,
};

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");
const { ProtocolError } = require("./errors");
const { capabilities, PROTOCOL_VERSION } = require("./protocol");
const { RenderSessionManager } = require("./render-session");

function setCommonHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  setCommonHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  response.end(body);
}

function sendText(response, statusCode, value) {
  const body = Buffer.from(value, "utf8");
  setCommonHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
  });
  response.end(body);
}

async function readJson(request, maxBodyBytes) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    request.resume();
    throw new ProtocolError("REQUEST_BODY_TOO_LARGE", "Request body exceeds configured limit", 413);
  }
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (contentType && !contentType.startsWith("application/json")) {
    request.resume();
    throw new ProtocolError("UNSUPPORTED_MEDIA_TYPE", "Expected application/json", 415);
  }

  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    throw new ProtocolError("REQUEST_BODY_TOO_LARGE", "Request body exceeds configured limit", 413);
  }
  if (bytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProtocolError("INVALID_JSON", "Request body is not valid JSON");
  }
}

function authorized(request, token) {
  if (!token) return true;
  const prefix = "Bearer ";
  const header = String(request.headers.authorization ?? "");
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function createRenderServer(config, { manager = new RenderSessionManager(config), onEvent } = {}) {
  let legacySessionId = null;
  if (onEvent) {
    for (const eventName of ["created", "chunk", "complete", "expired", "session-error"]) {
      manager.on(eventName, (payload) => {
        try {
          onEvent(eventName, payload);
        } catch {
          // Preview observers must never alter a completed protocol operation.
        }
      });
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://localhost");
      const pathname = requestUrl.pathname;

      if (request.method === "GET" && pathname === "/") {
        sendText(response, 200, "RoRenderV3 headless provider is running.\n");
        return;
      }
      if (request.method === "GET" && pathname === "/v1/health") {
        sendJson(response, 200, {
          status: "ready",
          protocol: PROTOCOL_VERSION,
        });
        return;
      }
      if (!authorized(request, config.authToken)) {
        response.setHeader("WWW-Authenticate", 'Bearer realm="RoRenderV3"');
        throw new ProtocolError("UNAUTHORIZED", "A valid bearer token is required", 401);
      }
      if (request.method === "GET" && pathname === "/v1/capabilities") {
        sendJson(response, 200, capabilities(config));
        return;
      }

      if (request.method === "POST" && pathname === "/v1/renders") {
        const body = await readJson(request, config.maxBodyBytes);
        const imageSize = body.imageSize ?? {};
        const status = manager.create({
          width: body.width ?? imageSize.width ?? imageSize.x,
          height: body.height ?? imageSize.height ?? imageSize.y,
          artifactName: body.artifactName,
          projection: body.projection,
        });
        sendJson(response, 201, {
          ...status,
          links: {
            status: `/v1/renders/${status.sessionId}`,
            chunks: `/v1/renders/${status.sessionId}/chunks`,
            complete: `/v1/renders/${status.sessionId}/complete`,
            image: `/v1/renders/${status.sessionId}/image`,
            manifest: `/v1/renders/${status.sessionId}/manifest`,
          },
        });
        return;
      }

      const route = pathname.match(/^\/v1\/renders\/([0-9a-f-]+)(?:\/(chunks|complete|image|manifest))?$/i);
      if (route) {
        const [, sessionId, action] = route;
        if (request.method === "GET" && !action) {
          sendJson(response, 200, manager.status(sessionId));
          return;
        }
        if (request.method === "DELETE" && !action) {
          manager.delete(sessionId);
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === "POST" && action === "chunks") {
          const body = await readJson(request, config.maxBodyBytes);
          const status = manager.append(sessionId, { offset: body.offset, pixels: body.pixels });
          sendJson(response, 202, status);
          return;
        }
        if (request.method === "POST" && action === "complete") {
          const status = await manager.complete(sessionId);
          sendJson(response, 200, status);
          return;
        }
        if (request.method === "GET" && action === "image") {
          const image = await manager.getImage(sessionId);
          setCommonHeaders(response);
          response.writeHead(200, { "Content-Type": "image/png", "Content-Length": image.length });
          response.end(image);
          return;
        }
        if (request.method === "GET" && action === "manifest") {
          sendJson(response, 200, manager.getManifest(sessionId));
          return;
        }
      }

      if (config.legacyEnabled && request.method === "POST" && pathname === "/render-begin") {
        const body = await readJson(request, config.maxBodyBytes);
        if (legacySessionId && manager.sessions.has(legacySessionId)) manager.delete(legacySessionId);
        const imageSize = body.imageSize ?? {};
        const status = manager.create({
          width: imageSize.x ?? imageSize.width,
          height: imageSize.y ?? imageSize.height,
          artifactName: body.artifactName ?? "legacy-map",
          projection: body.projection,
        });
        legacySessionId = status.sessionId;
        sendJson(response, 200, { sessionId: legacySessionId, protocol: "legacy-v3" });
        return;
      }
      if (config.legacyEnabled && request.method === "POST" && pathname === "/data") {
        if (!legacySessionId) {
          throw new ProtocolError("LEGACY_RENDER_NOT_STARTED", "Call /render-begin first", 409);
        }
        const body = await readJson(request, config.maxBodyBytes);
        const pixels = Array.isArray(body) ? body : body.pixels;
        const offset = Array.isArray(body) ? undefined : body.offset;
        const status = manager.append(legacySessionId, { offset, pixels });
        sendJson(response, 202, {
          receivedPixels: status.receivedPixels,
          totalPixels: status.totalPixels,
        });
        return;
      }
      if (config.legacyEnabled && request.method === "POST" && pathname === "/render-done") {
        if (!legacySessionId) {
          throw new ProtocolError("LEGACY_RENDER_NOT_STARTED", "Call /render-begin first", 409);
        }
        const status = await manager.complete(legacySessionId);
        sendJson(response, 200, status);
        return;
      }

      throw new ProtocolError("ROUTE_NOT_FOUND", "Route not found", 404);
    } catch (error) {
      const normalized = error instanceof ProtocolError
        ? error
        : new ProtocolError("INTERNAL_ERROR", "The render provider could not process the request", 500);
      if (!response.headersSent) {
        sendJson(response, normalized.statusCode, {
          error: {
            code: normalized.code,
            message: normalized.message,
            ...(normalized.details ? { details: normalized.details } : {}),
          },
        });
      } else {
        response.destroy();
      }
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 500;

  return {
    manager,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

module.exports = { authorized, createRenderServer, readJson };

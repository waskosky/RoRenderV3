# RoRenderV3 — maintained headless fork

This repository is a maintained fork of [A.J. Steinhauser's RoRenderV3](https://github.com/AJSteinhauser/RoRenderV3),
an orthographic renderer for Roblox workspaces. It preserves the original
desktop workflow while adding a small, machine-readable provider that tools
such as RAI can run without Electron.

The original project is no longer updated. This fork is independently
maintained and is not affiliated with Roblox Corporation. See [NOTICE.md](NOTICE.md)
and [LICENSE](LICENSE) for attribution and licensing.

## What this fork adds

- A dependency-free Node.js HTTP provider with a versioned `/v1` protocol.
- PNG output plus a `.map.json` sidecar containing the Roblox world-to-pixel
  transform needed by map and minimap UIs.
- Strict resource limits, contiguous chunk receipts, safe artifact names,
  private output permissions, and authenticated remote binding.
- A compatibility adapter for the original `/render-begin`, `/data`, and
  `/render-done` plugin endpoints.
- A sandboxed Electron renderer with context isolation and a narrow preload API.
- Node-native tests and a machine-readable protocol schema.

RoRender only receives pixels and creates local artifacts. It deliberately does
not publish Roblox assets or mutate an experience. A caller should separately
upload the resulting PNG, record the resulting Roblox asset ID, and install its
own map UI using the sidecar transform.

## Requirements

- Node.js 22.12 or newer (the headless core also works on Node.js 20, but the
  current desktop build toolchain requires 22.12).
- A Roblox Studio plugin or RAI adapter capable of streaming packed RGBA pixels.
- Electron is needed only for the optional desktop preview.

## Headless quick start

```sh
npm ci --omit=dev
npm run doctor
npm run serve
```

The provider listens on `127.0.0.1:8081` and writes artifacts to `./renders` by
default. It prints one JSON readiness record to stdout so a supervising tool can
wait for admission without scraping prose.

```json
{"event":"ready","protocol":"rorender.v1","url":"http://127.0.0.1:8081"}
```

Create a render with world bounds, stream pixels, and finalize it:

```sh
curl -sS -X POST http://127.0.0.1:8081/v1/renders \
  -H 'content-type: application/json' \
  --data '{"width":2,"height":1,"artifactName":"town-map","projection":{"plane":"xz","north":"negative-z","bounds":{"minX":-512,"minZ":-512,"maxX":512,"maxZ":512}}}'

curl -sS -X POST http://127.0.0.1:8081/v1/renders/SESSION_ID/chunks \
  -H 'content-type: application/json' \
  --data '{"offset":0,"pixels":[4278190335,4294967295]}'

curl -sS -X POST http://127.0.0.1:8081/v1/renders/SESSION_ID/complete
```

Read `GET /v1/capabilities` for negotiated limits and feature support. See
[docs/PROTOCOL.md](docs/PROTOCOL.md) and
[protocol/rorender-v1.schema.json](protocol/rorender-v1.schema.json) for the
integration contract.

New clients can optionally bind an externally consumed render to their
caller-owned canonical render intent by sending a 64-character lowercase
SHA-256 `requestDigest` when creating the session. The provider echoes it in
status receipts and the completed map manifest; clients that omit it remain
fully supported.

## Desktop preview

Install development dependencies and start Electron:

```sh
npm ci
npm start
```

Select **Start local provider**, then render from Studio. Completed renders are
written automatically and can also be copied to a user-selected PNG path.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `RORENDER_HOST` | `127.0.0.1` | Bind host |
| `RORENDER_PORT` | `8081` | Bind port |
| `RORENDER_OUTPUT_DIR` | `./renders` | Artifact directory |
| `RORENDER_AUTH_TOKEN` | unset | Bearer token; required off loopback |
| `RORENDER_MAX_PIXELS` | `16777216` | Maximum pixels per render |
| `RORENDER_MAX_CHUNK_PIXELS` | `262144` | Maximum packed pixels per request |
| `RORENDER_MAX_BODY_BYTES` | `4194304` | Maximum JSON request bytes |
| `RORENDER_MAX_SESSIONS` | `4` | Retained session limit |
| `RORENDER_SESSION_TTL_MS` | `900000` | Idle session retention |
| `RORENDER_PNG_COMPRESSION` | `6` | PNG compression level from 0–9 |
| `RORENDER_LEGACY_ENABLED` | loopback only | Enable V3 compatibility routes |

CLI flags exist for non-secret settings. Authentication tokens are accepted
only from the environment to avoid exposing them in process listings.

## Validation

```sh
npm run validate
npm audit
```

Migration guidance for existing V3 plugins is in
[docs/MIGRATION.md](docs/MIGRATION.md).

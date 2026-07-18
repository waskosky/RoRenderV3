# RoRender provider protocol v1

The v1 protocol is an ordered pixel-ingestion interface. It is intentionally
small: the Roblox-side component owns orthographic sampling, while this process
owns validation, PNG encoding, durable artifacts, and projection metadata.

## Discovery and admission

1. Start `node bin/rorender.js serve`.
2. Wait for the JSON `ready` record on stdout.
3. Require `GET /v1/health` to return `protocol: "rorender.v1"`.
4. Read `GET /v1/capabilities` and honor its advertised limits.

Only `/` and `/v1/health` are unauthenticated. When
`RORENDER_AUTH_TOKEN` is set, send `Authorization: Bearer <token>` to all
render and capability routes.

## Render lifecycle

### 1. Create

`POST /v1/renders`

```json
{
  "width": 1024,
  "height": 1024,
  "artifactName": "coastal-town",
  "requestDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "projection": {
    "plane": "xz",
    "north": "negative-z",
    "bounds": {
      "minX": -2048,
      "minZ": -2048,
      "maxX": 2048,
      "maxZ": 2048
    }
  }
}
```

`artifactName` is a logical stem, not a path. The provider appends a random
session ID and never accepts a caller-controlled destination path.

`requestDigest` is an optional request-binding value. When present, it must be
the 64-character lowercase hexadecimal encoding of a SHA-256 digest. The
provider treats the digest as opaque caller metadata: it validates and retains
the exact value, echoes it in create and status receipts, and writes it to
`render.requestDigest` in the completed manifest. A consumer admitting an
externally completed session should compare that value with its independently
computed expected request digest before accepting the artifact. Canonicalization
of the caller-owned render intent is deliberately outside the provider
protocol; clients must use the same stable input on creation and admission.
Existing clients may omit the field; omitted values are not added to receipts
or manifests. Discovery exposes this contract under `requestBinding` in `GET
/v1/capabilities`.

Projection metadata is optional but strongly recommended for a map provider.
The only currently supported plane is Roblox `xz`. `north: negative-z` maps
`minZ` to the top of the image; `positive-z` maps `maxZ` to the top.

### 2. Append contiguous chunks

`POST /v1/renders/{sessionId}/chunks`

```json
{
  "offset": 0,
  "pixels": [4278190335, 4294967295]
}
```

Each number is an unsigned packed RGBA pixel. Red occupies bits 0–7, green
8–15, blue 16–23, and alpha 24–31. `offset` is a pixel index, not a byte index.
It must equal the receipt's `receivedPixels`; out-of-order, duplicated, and
overlapping chunks fail with `NON_CONTIGUOUS_CHUNK`. This makes retries
deterministic: query status, then resend only from the reported next offset.

### 3. Complete

`POST /v1/renders/{sessionId}/complete`

Completion fails until every declared pixel has arrived. On success, the
provider writes:

- `<artifact>-<session>.png`
- `<artifact>-<session>.map.json`

The sidecar includes image dimensions, image SHA-256, optional request binding,
projection bounds, north orientation, and affine world-to-pixel coefficients.
The coefficients map an in-world `(x, z)` location to a top-left pixel location:

```text
pixelX = x * xScale + xOffset
pixelY = z * zScale + zOffset
```

### 4. Consume and release

- `GET /v1/renders/{sessionId}` returns compact state and progress.
- `GET /v1/renders/{sessionId}/image` returns the completed PNG.
- `GET /v1/renders/{sessionId}/manifest` returns the same machine-readable map
  manifest written beside the PNG.
- `DELETE /v1/renders/{sessionId}` releases retained pixel memory. Generated
  artifacts remain on disk under the configured output directory.

## Recommended RAI provider flow

Treat RoRender as an optional offline projection provider, not a universal map
UI implementation:

1. Resolve experience bounds from the same world manifest used by generation.
2. Start and admit the provider through health and capabilities checks.
3. Ask the Studio adapter to sample the declared bounds and stream chunks.
4. Verify the completion receipt, request digest binding, PNG SHA-256, and
   sidecar schema.
5. Publish the PNG through RAI's separately authorized Roblox asset pipeline.
6. Materialize the chosen map/minimap UI from a reusable experience template.
7. Persist the Roblox asset ID and world-to-pixel transform in the experience
   manifest for player/objective markers.

If the provider is absent or fails admission, the map tool should report an
unsupported optional capability. It should not silently substitute a list of
location names for a requested spatial map.

## Error contract

Errors are JSON and stable by `code`:

```json
{
  "error": {
    "code": "NON_CONTIGUOUS_CHUNK",
    "message": "Expected chunk offset 2048",
    "details": { "expectedOffset": 2048 }
  }
}
```

Callers should branch on `code`, not message text. `4xx` responses are caller or
state errors; `5xx` responses indicate provider/configuration failures.

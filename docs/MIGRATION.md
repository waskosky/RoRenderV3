# Migrating from legacy RoRenderV3

## Compatibility mode

Existing local Studio plugins can continue to use:

- `POST /render-begin` with `{ "imageSize": { "x": width, "y": height } }`
- `POST /data` with a JSON array of packed pixels
- `POST /render-done`

Compatibility routes are enabled by default only on loopback. They now produce
a PNG and manifest automatically. Pixel decoding also uses one four-byte RGBA
slot per packed value; the legacy UI's overlapping-byte indexing bug is not
preserved.

The new server returns small JSON receipts, which old clients may ignore. A new
render replaces the retained compatibility session but does not delete prior
artifacts.

## Moving a plugin or orchestration adapter to v1

1. Replace the hardcoded readiness assumption with `/v1/health` and
   `/v1/capabilities` admission.
2. Create a named render and retain the returned `sessionId`.
3. Send an explicit pixel `offset` with every chunk.
4. On a network retry, read session status before sending more data.
5. Call `/complete` and verify the returned SHA-256.
6. Delete the retained session after consuming the artifact.

Do not expose the provider outside the host merely to reach it from Studio. The
Roblox plugin and provider normally run on the same workstation. If remote
binding is an intentional deployment decision, set a strong
`RORENDER_AUTH_TOKEN`, use a private network or authenticated reverse proxy, and
disable legacy endpoints.

## Desktop security changes

The renderer no longer has Node.js access. Electron runs with sandboxing,
context isolation, navigation denial, and a small preload bridge. Remote fonts
and scripts were removed. The export action writes only the provider-generated
PNG selected through the native save dialog.

## Removed packages

The headless provider uses Node's standard library. Legacy packages that
duplicated Node built-ins or were unused (`fs`, `path`, `url`, Express, Fastify,
body-parser, jQuery, Jimp, temporary-file wrappers, and unhandled-error helpers)
were removed. Electron and its builder remain development-only dependencies for
the optional desktop app.

## Known boundaries

- This fork does not include the original Roblox sampling plugin source.
- The protocol accepts packed pixel arrays, not compressed/binary chunk bodies.
- Only an `xz` orthographic projection is currently represented in map
  manifests.
- Roblox image publication and runtime map UI installation belong to the caller.

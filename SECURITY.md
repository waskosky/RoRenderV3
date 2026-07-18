# Security policy

Please report vulnerabilities privately to the fork owner before opening a
public issue when practical.

## Deployment assumptions

RoRender processes render data from a trusted local Studio session. The default
configuration binds only to `127.0.0.1`. Non-loopback binding is rejected unless
`RORENDER_AUTH_TOKEN` contains at least 24 characters.

The provider does not implement TLS. For intentional remote deployments, place
it behind an authenticated TLS reverse proxy on a private network, keep legacy
routes disabled, and rotate the bearer token through the process environment.

Output is confined to `RORENDER_OUTPUT_DIR`; clients cannot provide filesystem
paths. JSON bodies, images, chunks, sessions, and idle retention are bounded.

Supported development should use a current Node.js release satisfying
`package.json` and the lockfile-pinned Electron toolchain. Run `npm audit` and
`npm run validate` before releases.

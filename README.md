# IP Watch

IP Watch is an internal dashboard for monitoring one IPv4 CIDR. The MVP is built as a single Node.js application and is run through Docker Compose in both development and production.

The repository implements stages 0 through 6 of the MVP plan: persisted IP state, Mock and real ARP/Ping scanning, HTTP/SSE APIs, the dashboard, and the hardened Ubuntu container runtime. Final Ubuntu network acceptance remains in stage 7.

## macOS development

Docker Desktop and Docker Compose v2 are the only host prerequisites. The development Compose file always enables the Mock Scanner setting and publishes the HTTP port on localhost only.

```sh
docker compose -f compose.dev.yaml up --build
```

After the container becomes healthy, check the process at <http://127.0.0.1:3000/health>.

Run the automated tests and TypeScript checks inside the development container:

```sh
docker compose -f compose.dev.yaml run --rm ip-watch npm test
docker compose -f compose.dev.yaml run --rm ip-watch npm run typecheck
```

The same checks can be run as an isolated image target:

```sh
docker build --target test .
```

To use a different localhost port, set `IP_WATCH_PORT`; to change the mock target subnet, set `TARGET_CIDR` before starting Compose.

## Ubuntu operation

Copy `.env.example` to `.env`, replace `TARGET_CIDR` and `NETWORK_INTERFACE` with values from the Ubuntu host, and then start the production service:

```sh
docker compose -f compose.yaml up -d --build
```

The production file uses host networking, a single `NET_RAW` capability, a non-root process, an HTTP healthcheck, and the `ip-watch-data` named volume at `/app/data`. It must be deployed only on a trusted internal network, never directly on the public internet.

See [docs/operations.md](./docs/operations.md) for Ubuntu prerequisites, deployment, security checks, log inspection, configuration changes, backup and restore, graceful shutdown, and incident handling.

## Configuration

All environment variables are read and validated before the HTTP server starts. `TARGET_CIDR` is required, supports at most 254 usable addresses, and rejects `/31` and `/32`. `NETWORK_INTERFACE` is also required unless `USE_MOCK_SCANNER=true`. See `.env.example` for every supported setting and its normal container value.

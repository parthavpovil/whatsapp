# whatsapp-service

Multi-tenant WhatsApp service built on `whatsapp-web.js`. Three Node/TypeScript processes (`api`, `worker`, `dispatcher`) backed by Postgres and Redis. Talks to backend-SaaS over HTTPS only — no shared infrastructure.

See [whatsapp-service-architecture.md](whatsapp-service-architecture.md) for architecture and rationale.

## Layout

```
packages/shared/       @wa/shared — cross-service contracts (zod schemas, types, hmac, redis-keys, env)
services/api/          @wa/api — Fastify HTTP intake, QR endpoint, allocator
services/worker/       @wa/worker — wwebjs Client host, one Chromium per session
services/dispatcher/   @wa/dispatcher — outbox poller, HMAC webhook delivery with retries
migrations/            node-pg-migrate, shared schema
tools/mock-backend/    @wa/mock-backend — local Fastify mock for E2E + dispatcher chaos modes
tools/smoke-test.sh    bash E2E driver against a running stack
```

## Quick start (local dev)

```bash
nvm use
npm install
cp .env.example .env

# Start infra only and run services with tsx watch:
docker compose up -d postgres redis minio minio-init
npm run migrate:up
npm run dev:api &
npm run dev:dispatcher &
npm run dev:worker
```

Or full stack via docker-compose:

```bash
docker compose up -d --build
docker compose run --rm whatsapp-api node -e "require('child_process').execSync('npm run migrate:up', {stdio:'inherit'})"
```

## Smoke test

Requires one real WhatsApp test number on a phone you can scan a QR with:

```bash
export TARGET_PHONE=15551234567   # your second number, E.164 without +
export BACKEND_TO_WA_SHARED_SECRET=$(grep BACKEND_TO_WA_SHARED_SECRET .env | cut -d= -f2-)
export WEBHOOK_SECRET=$(grep MOCK_WEBHOOK_SECRET docker-compose.yml | head -1 | awk -F'-' '{print $NF}' | tr -d ' }')
./tools/smoke-test.sh
```

## Scripts

- `npm run lint` / `lint:fix` — biome
- `npm run typecheck` — `tsc -b` across workspaces
- `npm run test` — vitest
- `npm run migrate:up` / `migrate:down` / `migrate:create <name>`
- `npm run dev:{api,worker,dispatcher}` — tsx watch
- `npm run build` — build all workspaces

## Endpoints

- api: `:8080` (REST)
- worker: `:9090/metrics`
- dispatcher: `:9091/metrics`
- mock-backend: `:9000` (POST /webhooks, GET /events, DELETE /events)
- minio: `:9000` (S3 API), `:9001` (web console)

## Environment

See [.env.example](.env.example). Every required env var is loaded and validated through `@wa/shared/env`.

## Highest-risk areas

1. [services/worker/src/postgres-store.ts](services/worker/src/postgres-store.ts) — RemoteAuth Postgres Store. Get this wrong and reassignment forces re-pair.
2. wwebjs version skew (pinned `1.26.0`, exact). Renovate flags upgrades; never auto-merge.
3. Chromium memory growth — RSS-threshold restart ([services/worker/src/main.ts](services/worker/src/main.ts) `memoryLoop`).
4. Dispatcher double-delivery race — mitigated by visibility-lease pattern in [services/dispatcher/src/poller.ts](services/dispatcher/src/poller.ts).
5. Inbound dedup race — single-tx `seen_wa_messages` + `events_outbox` insert in [services/worker/src/handlers/on-message.ts](services/worker/src/handlers/on-message.ts).
# whatsapp

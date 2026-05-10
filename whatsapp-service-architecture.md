# WhatsApp Service Architecture

A scalable, multi-tenant WhatsApp service built on `whatsapp-web.js` (wwebjs), decoupled from your main chat-SaaS backend. Communicates with the backend over HTTPS only — no shared infrastructure.

---

## Honest framing — read this first

Before any architecture: wwebjs drives WhatsApp Web via Puppeteer. It is **unofficial, against WhatsApp's ToS, and accounts get banned** — especially new numbers, high-volume numbers, and numbers that send identical messages instantly to many people.

Whatever you build, design it assuming **any session can die or get banned at any moment**. Also:

- Each session is one Chromium instance, **~300–500 MB RAM**.
- You scale **across accounts**, never within one. One WhatsApp number = one session, period.
- WhatsApp pushes Web updates that break wwebjs without warning. You'll be on a treadmill.

If volumes ever justify it, push hard for the official **WhatsApp Cloud API** in parallel. The architecture below maps onto it almost identically — only the worker layer changes.

---

## Service layout

Three processes inside the WhatsApp service boundary, plus Postgres and Redis. Backend talks to it only over HTTPS (commands in, webhooks out).

| Service | Stateful? | Scales on | Responsibility |
|---|---|---|---|
| `whatsapp-api` | No | CPU / replicas | HTTP intake from backend, QR pairing, status queries |
| `whatsapp-worker` | **Yes** | Number of accounts | Hosts wwebjs `Client` instances; one account = one session = one worker |
| `whatsapp-dispatcher` | No | Outbox throughput | Polls events outbox, posts webhooks to backend with retries |
| `postgres` | — | — | Sessions, idempotency, outbox, ownership leases |
| `redis` | — | — | Routing, queues, rate limits, dedup, locks |

The api process is stateless so you can autoscale on CPU. The worker is the only thing that knows about wwebjs, holds Chromium, and has session affinity — autoscaling it on CPU will hurt you. The dispatcher exists because you don't want network calls to the backend on the worker's hot path; webhooks need retry semantics.

Folding dispatcher into the api process is acceptable for v1 — keep them separable.

---

## Architecture diagram

```
┌──────────────┐                ┌─────────────────────────────────────────────────┐
│              │                │  WhatsApp service · your boundary                │
│              │                │                                                  │
│   Backend    │ POST /commands │   ┌──────────────┐         ┌──────────────┐    │
│    SaaS      │ ─────────────► │   │ whatsapp-api │ ──────► │    Redis     │    │
│              │                │   │  HTTP intake │         │  queues,     │    │
│  your        │                │   └──────────────┘         │  leases,     │    │
│  existing    │                │                            │  dedup,      │    │
│  app         │                │   ┌──────────────┐         │  ratelimits  │    │
│              │                │   │  Postgres    │         └──────┬───────┘    │
│              │                │   │  sessions,   │                │            │
│              │                │   │  outbox,     │                ▼            │
│              │                │   │  idempotency │         ┌──────────────┐    │   ┌──────────┐
│              │                │   └──────┬───────┘         │ wwebjs       │    │   │          │
│              │ ◄───────────── │          ▲                 │ workers      │ ─► │ ─►│ WhatsApp │
│              │ POST /webhooks │          │                 │              │    │   │  WA Web  │
│              │                │   ┌──────┴───────┐         │ ┌──────────┐ │ ◄─ │ ◄─│          │
│              │                │   │ dispatcher   │ ◄────── │ │session A │ │    │   │          │
│              │                │   │ outbox       │         │ ├──────────┤ │    │   └──────────┘
│              │                │   │ publisher    │         │ │session B │ │    │
└──────────────┘                │   └──────────────┘         │ ├──────────┤ │    │
                                │                            │ │session C │ │    │
                                │                            │ └──────────┘ │    │
                                │                            └──────────────┘    │
                                └─────────────────────────────────────────────────┘
```

**Mermaid version** (renders in GitHub/GitLab):

```mermaid
flowchart LR
    Backend[Backend SaaS<br/>your existing app]

    subgraph Boundary [WhatsApp service · your boundary]
        API[whatsapp-api<br/>HTTP intake]
        Redis[(Redis<br/>queues, leases<br/>dedup, ratelimits)]
        PG[(Postgres<br/>sessions, outbox<br/>idempotency)]
        Dispatcher[dispatcher<br/>outbox publisher]
        Workers[wwebjs workers<br/>session A, B, C, ...]
    end

    WA[WhatsApp<br/>WA Web]

    Backend -->|POST /commands| API
    API --> Redis
    Redis --> Workers
    Workers --> PG
    PG --> Dispatcher
    Dispatcher -->|POST /webhooks| Backend
    Workers <-->|wwebjs| WA
```

---

## Postgres schema

Your service owns its own database. **No shared tables with the backend SaaS**, only HTTPS in and out.

```sql
-- one row per connected WhatsApp number (= per backend's wa_account_id)
CREATE TABLE wa_accounts (
  id                  uuid PRIMARY KEY,        -- = backend's wa_account_id
  workspace_id        uuid NOT NULL,           -- backend's tenant id (denormalised, useful for ops)
  phone_number        text,                    -- E.164, populated after pairing
  status              text NOT NULL,           -- pending|qr_required|authenticated|connected|disconnected|banned
  webhook_url         text NOT NULL,           -- where dispatcher posts events for this account
  webhook_secret      text NOT NULL,           -- HMAC key
  worker_id           text,                    -- null if unassigned
  lease_expires_at    timestamptz,             -- worker must heartbeat before this
  last_qr             text,                    -- for the pairing UI
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON wa_accounts (worker_id) WHERE worker_id IS NOT NULL;
CREATE INDEX ON wa_accounts (lease_expires_at) WHERE worker_id IS NOT NULL;

-- wwebjs auth state. Replaces LocalAuth filesystem with a DB-backed RemoteAuth store.
CREATE TABLE wa_session_blobs (
  wa_account_id       uuid PRIMARY KEY REFERENCES wa_accounts(id) ON DELETE CASCADE,
  blob                bytea NOT NULL,          -- gzipped tar of the wwebjs session folder
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- idempotency for outbound commands. command_id is the dedup key.
CREATE TABLE outbound_commands (
  command_id          uuid PRIMARY KEY,        -- from backend
  wa_account_id       uuid NOT NULL REFERENCES wa_accounts(id),
  payload             jsonb NOT NULL,          -- to, type, payload from the backend's command
  status              text NOT NULL,           -- queued|sending|sent|failed
  wa_message_id       text,                    -- populated on ack
  attempts            int NOT NULL DEFAULT 0,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX ON outbound_commands (wa_account_id, status);

-- transactional outbox: every event we owe the backend lives here until delivered.
CREATE TABLE events_outbox (
  event_id            uuid PRIMARY KEY,        -- UUID v7, monotonic
  wa_account_id       uuid NOT NULL REFERENCES wa_accounts(id),
  event_type          text NOT NULL,           -- message.sent_ack | message.delivered | message.read
                                               -- | message.incoming | session.connected
                                               -- | session.disconnected | session.qr | session.banned
  payload             jsonb NOT NULL,
  attempts            int NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- the dispatcher's working set: undelivered events ready to go
CREATE INDEX events_outbox_pending_idx
  ON events_outbox (next_attempt_at)
  WHERE delivered_at IS NULL;

-- inbound dedup. wwebjs occasionally fires the same message event twice on reconnect.
CREATE TABLE seen_wa_messages (
  wa_account_id       uuid NOT NULL,
  wa_message_id       text NOT NULL,
  seen_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_account_id, wa_message_id)
);
-- prune monthly with a cron: DELETE WHERE seen_at < now() - interval '30 days';
```

### Why these tables

- **`events_outbox`** is a transactional outbox, not Kafka. You write the event in the same transaction as whatever caused it. The dispatcher polls with `FOR UPDATE SKIP LOCKED`. This pattern is boring and bulletproof. Don't reach for Kafka here.
- **`outbound_commands`** is your idempotency table — same pattern as Stripe. If the backend retries the same `command_id`, you `INSERT ... ON CONFLICT (command_id) DO NOTHING RETURNING ...` and respond with the existing row's status. Never send the same `command_id` to WhatsApp twice.
- **`wa_session_blobs`** is critical. wwebjs ships with `LocalAuth` (writes to disk) and `RemoteAuth` (writes to a remote store, has S3 support out of the box). Disk is the wrong choice once you have more than one worker — a session pinned to disk on worker A can't be picked up by worker B when A dies. Implement a small `Store` class for `RemoteAuth` that reads/writes the gzipped tar from this Postgres table. ~100 lines of code.

---

## Redis key layout

```
# session ownership lease — worker writes this with TTL, refreshes on heartbeat
session:owner:{wa_account_id}        -> {worker_id}                  TTL 30s

# worker presence + capacity
worker:heartbeat:{worker_id}         -> {iso_timestamp}              TTL 30s
worker:capacity:{worker_id}          -> int (current session count)  no TTL

# outbound work queue, one Redis list per worker (or one stream — see below)
queue:worker:{worker_id}             -> LIST<command_payload_json>

# command_id idempotency fast-path (Postgres is source of truth, this just avoids the round-trip)
dedup:command:{command_id}           -> "1"                          TTL 24h

# wwebjs sometimes re-fires events; fast inbound dedup before hitting Postgres
dedup:event:{wa_account_id}:{wa_message_id}  -> "1"                  TTL 24h

# per-account outbound rate limit (token bucket via Lua)
ratelimit:account:{wa_account_id}    -> bucket state

# the QR code for an account currently pairing — short-lived
session:qr:{wa_account_id}           -> {base64_png}                 TTL 60s
```

For the rate limit, use a Lua script implementing a token bucket. Start conservative: **1 message/sec/account with a burst of 10**. WhatsApp doesn't publish limits for unofficial clients; numbers get rate-limited or banned by behavioural heuristics. You will tune this empirically and you will get it wrong before you get it right.

If outbound traffic per account is ever spikey, swap `LIST` for a Redis Stream (`XADD`/`XREADGROUP`) — gives you consumer groups, acks, and pending entry inspection. For v1, `LPUSH`/`BRPOP` is fine.

---

## Outbound flow (backend → WhatsApp)

```
backend                          api                              redis              postgres            worker            whatsapp
   |                              |                                 |                    |                  |                  |
   |--POST /commands ------------>|                                 |                    |                  |                  |
   |  {command_id, wa_account_id, |                                 |                    |                  |                  |
   |   to, type, payload}         |                                 |                    |                  |                  |
   |                              |-- SETNX dedup:command:{id} --->|                    |                  |                  |
   |                              |   (if exists, fetch current     |                    |                  |                  |
   |                              |    status from PG and return)   |                    |                  |                  |
   |                              |                                 |                    |                  |                  |
   |                              |-- INSERT outbound_commands ---------------------- ->|                  |                  |
   |                              |   (status='queued')             |                    |                  |                  |
   |                              |                                 |                    |                  |                  |
   |                              |-- GET session:owner:{wa_acct} ->|                    |                  |                  |
   |                              |<-- worker_id ------------------|                    |                  |                  |
   |                              |                                 |                    |                  |                  |
   |                              |-- LPUSH queue:worker:{id} ---->|                    |                  |                  |
   |<--202 Accepted---------------|                                 |                    |                  |                  |
   |                              |                                 |                    |                  |                  |
   |                              |                                 |<-- BRPOP ----------|------------------|                  |
   |                              |                                 |                    |                  |-- consume rate -|
   |                              |                                 |                    |                  |   limit token   |
   |                              |                                 |                    |                  |                  |
   |                              |                                 |                    |                  |-- client.sendMessage ->|
   |                              |                                 |                    |                  |<- wa_message_id -|
   |                              |                                 |                    |                  |                  |
   |                              |                                 |                    |<-- UPDATE outbound_commands SET status='sent', wa_message_id=...
   |                              |                                 |                    |<-- INSERT events_outbox (event_type='message.sent_ack', ...)
   |                              |                                 |                    |                  |                  |
   |                              |                                 |                    | dispatcher polls outbox ...         |
   |<--POST /webhooks-------------+---------------------------------|--------------------|------------------|                  |
   |  message.sent_ack            |                                 |                    |                  |                  |
   |--200 OK--------------------->|                                 |                    | UPDATE delivered_at = now()         |
```

**Key detail:** the worker does not call the backend. It writes to the outbox in the **same Postgres transaction** as updating `outbound_commands`. The dispatcher is the only thing that talks to backend webhooks. This way a slow or down backend can't stall message sending.

### Dispatcher loop

```sql
-- Pull a batch, mark them in-flight via SKIP LOCKED so multiple dispatcher replicas don't double-deliver
BEGIN;
SELECT event_id, wa_account_id, event_type, payload, attempts
  FROM events_outbox
 WHERE delivered_at IS NULL
   AND next_attempt_at <= now()
 ORDER BY next_attempt_at
   FOR UPDATE SKIP LOCKED
 LIMIT 100;
COMMIT; -- short tx; do the HTTP outside the lock
```

For each event:

1. HMAC-sign the body with the per-account `webhook_secret`, POST it.
2. **On `2xx`:** `UPDATE delivered_at=now()`.
3. **On `4xx`** (except 408/429): mark `delivered_at=now()` with `last_error` set and a flag — these are non-retriable. Alert.
4. **On `5xx` / timeout:** `UPDATE attempts=attempts+1, next_attempt_at = now() + backoff(attempts), last_error=...`.

Backoff: `min(2^attempts, 3600) seconds` with jitter.

---

## Inbound flow (WhatsApp → backend)

```
whatsapp ---message---> wwebjs in worker
                                |
                                | dedup check: SETNX dedup:event:{acct}:{wa_msg_id}
                                |   if already set, drop
                                |
                                | INSERT seen_wa_messages (acct, wa_msg_id) ON CONFLICT DO NOTHING
                                |   if 0 rows affected, drop (race-safe dedup)
                                |
                                | INSERT events_outbox (
                                |   event_id = uuidv7(),
                                |   event_type = 'message.incoming',
                                |   payload = { wa_message_id, from, to, type, body, media_url, pushname, ... }
                                | )
                                |
dispatcher ---POST /webhooks--> backend
                                |
                              <-- 200
                                | UPDATE delivered_at
```

### Media handling

- **Inbound media:** wwebjs gives you a `MessageMedia` object on incoming media. `await msg.downloadMedia()` → base64 → upload to your object storage (R2/S3) → write `media_url` (not the base64) to the outbox event payload. Don't ship base64 in the event payload, that path is a footgun.
- **Outbound media:** the backend's command has `payload.media_url` pointing to their R2. The worker fetches it (with size cap, e.g. 16 MB), constructs `MessageMedia` from buffer, calls `client.sendMessage(to, media, { caption })`. Don't trust the URL blindly — restrict to backend's bucket via signed URLs or domain allowlist.

---

## Session lifecycle and worker assignment

A WhatsApp number = one wwebjs `Client` = one Chromium = one worker. Workers must be sticky.

### Pairing (new account)

1. Backend calls `POST /accounts` on the api with `{wa_account_id, workspace_id, webhook_url, webhook_secret}`.
2. api inserts `wa_accounts` row with `status='pending'`, `worker_id=null`.
3. The **allocator** (a goroutine in api, or a tiny separate process) wakes periodically:
   ```sql
   SELECT id FROM wa_accounts
    WHERE worker_id IS NULL OR lease_expires_at < now()
    ORDER BY created_at LIMIT 50;
   ```
   For each, picks a worker with capacity (alive per `worker:heartbeat:{id}`, lowest `worker:capacity:{id}`) and atomically claims:
   ```sql
   UPDATE wa_accounts SET worker_id=?, lease_expires_at=now()+interval '30 seconds'
    WHERE id=? AND (worker_id IS NULL OR lease_expires_at < now());
   ```
4. The chosen worker, on its next tick, queries `SELECT id FROM wa_accounts WHERE worker_id=$me AND lease_expires_at > now()` and sees the new assignment.
5. Worker creates a `Client` with `RemoteAuth` (Postgres-backed store). Since it's a new account, no session blob exists. wwebjs emits `qr` event → worker writes it to Redis at `session:qr:{wa_account_id}` and emits `session.qr` to outbox → backend renders it.
6. User scans QR. wwebjs emits `authenticated` (status → `authenticated`), then `ready` (status → `connected`). Worker emits `session.connected` to outbox.
7. wwebjs `RemoteAuth` periodically saves session blob to Postgres.

### Heartbeat / lease renewal

Worker every ~10s:

```sql
UPDATE wa_accounts SET lease_expires_at = now()+interval '30 seconds'
 WHERE id IN (...) AND worker_id=$me;
```

Plus `SET worker:heartbeat:{id}` and `SET session:owner:{acct}` with TTL. If the worker dies, leases expire in ≤30s and the allocator reassigns.

### Reassignment after worker death

When worker B picks up an account previously owned by A, it loads the session blob from Postgres and starts a `Client`. wwebjs reconnects to WhatsApp using that auth state without re-pairing. **This is the whole point of `RemoteAuth` over `LocalAuth`.**

### Capacity per worker

Start with **10 concurrent sessions per worker**. Memory budget: ~5 GB per worker is realistic. You'll hit Chromium-related memory leaks; restart workers on a 6–12 hour schedule (graceful: stop accepting new assignments, let leases drift to other workers, then exit).

---

## Failure modes you must plan for

In rough order of likelihood:

### Account gets banned
wwebjs emits `disconnected` with reason or auth fails on reconnect. Detect, set `status='banned'`, emit `session.banned` event, stop reassigning that account. The phone number is dead — needs human intervention.

### wwebjs version skew with WhatsApp Web
WhatsApp pushes a Web update, wwebjs breaks. Pin a specific wwebjs version, watch the GitHub issues, have a rollback plan. Run a canary worker on every wwebjs upgrade with one test account before rolling to prod.

### Session blob corruption
Auth state goes bad, `Client` won't connect. Detect via repeated `auth_failure` events, wipe `wa_session_blobs` row, force re-pairing, emit `session.qr_required` event. Backend needs to handle this UX.

### Worker OOM
Chromium leaks. Plan for it: graceful restart on memory threshold, hard restart by orchestrator if it pegs. Sessions reassign automatically via lease expiry.

### Backend webhook is down
Outbox keeps growing. Set an alert when `SELECT count(*) FROM events_outbox WHERE delivered_at IS NULL` exceeds some threshold per workspace. The dispatcher's exponential backoff will keep retrying; nothing is lost.

### Dispatcher crashes mid-delivery
It either delivered (backend got it) or didn't. Backend dedups on `event_id`. You can safely retry. This is why `event_id` is the idempotency key in the contract — your design gets that for free.

### Two workers race for the same account during reassignment
The atomic `UPDATE ... WHERE worker_id IS NULL OR lease_expires_at < now()` makes this impossible at the DB level. The loser sees 0 rows updated and moves on. **Don't trust Redis alone for this — Postgres is the source of truth for ownership.**

---

## Docker compose to start with

```yaml
version: "3.9"
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: wa_service
      POSTGRES_USER: wa
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
    ports: ["5432:5432"]

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory-policy noeviction
    volumes:
      - redis_data:/data
    ports: ["6379:6379"]

  whatsapp-api:
    build: ./api
    environment:
      DATABASE_URL: postgres://wa:${POSTGRES_PASSWORD}@postgres:5432/wa_service
      REDIS_URL: redis://redis:6379
      PORT: 8080
    depends_on: [postgres, redis]
    ports: ["8080:8080"]
    deploy:
      replicas: 2

  whatsapp-worker:
    build: ./worker
    environment:
      DATABASE_URL: postgres://wa:${POSTGRES_PASSWORD}@postgres:5432/wa_service
      REDIS_URL: redis://redis:6379
      WORKER_ID: ${HOSTNAME}            # one worker per container, host-unique
      MAX_SESSIONS: 10
    depends_on: [postgres, redis]
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 6G

  whatsapp-dispatcher:
    build: ./dispatcher
    environment:
      DATABASE_URL: postgres://wa:${POSTGRES_PASSWORD}@postgres:5432/wa_service
    depends_on: [postgres]
    deploy:
      replicas: 2

volumes:
  pg_data:
  redis_data:
```

`maxmemory-policy noeviction` on Redis is deliberate — you don't want Redis silently dropping queue entries under pressure. If you OOM, you want it loud, not silent corruption. Persist Redis (`appendonly yes`) so a restart doesn't lose queued commands; outbound commands are also in Postgres so worst case is a brief delivery delay.

---

## Final notes

### `workspace_id` on every event
Lives on every event payload and table for a reason — when the backend gets a webhook, it needs to know which tenant. Don't rely on the `wa_account_id` lookup alone; pass `workspace_id` explicitly in webhook payloads. Cheap, prevents a class of bugs.

### Hide `worker_id` from the backend
The backend never sees it. Keep it that way. Worker assignment is purely an internal concern of your service. The backend talks `wa_account_id` and gets events back, never knows or cares which worker handled it.

### QR pairing UX
Expose `GET /accounts/:id/qr` on `whatsapp-api` that long-polls or SSEs the QR code from Redis. Backend embeds this in their UI. **Don't try to push the QR through the webhook** — too many failure modes for a 60-second pairing window.

### Plan for the official Cloud API in parallel
The architecture above maps onto WhatsApp Cloud API almost identically — replace the `wwebjs workers` box with a thin HTTP client to Meta's API, replace QR pairing with phone number registration, drop the Chromium memory budget. The api/dispatcher/Postgres/Redis layout doesn't change. If you build the contract right, you can run both backends behind the same `wa_account` interface and route per-account based on which provider the tenant is using.

---

## Identifier glossary (matches your backend's contract)

| ID | Generated by | Where it lives in WA service |
|---|---|---|
| `workspace_id` | backend | `wa_accounts.workspace_id` (denormalised) |
| `wa_account_id` | backend | `wa_accounts.id` (PK) |
| `command_id` | backend | `outbound_commands.command_id` (PK) |
| `wa_message_id` | WhatsApp | `outbound_commands.wa_message_id`, payload of inbound events |
| `event_id` | WA service (UUID v7) | `events_outbox.event_id` (PK) |
| `worker_id` | WA service | `wa_accounts.worker_id`, Redis ownership keys — **internal only** |
| `contact_id`, `conversation_id`, `message_id` | backend | not stored here — backend's concern |

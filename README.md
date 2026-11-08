# llm-gateway

The model gateway of the platform: every service calls models only through it. An OpenAI-compatible API over the owner's subscriptions: Codex CLI (ChatGPT Plus), Claude Code CLI (Claude subscription); Gemini comes later. MiniMax was dropped (D-111). The caller picks the model and the reasoning effort; the gateway picks the account, waits for a slot, gets an answer that matches the JSON Schema (one correction round), pauses an account until its usage limit resets and journals every call.

Created from [`nest-starter`](https://github.com/nick-lukashik/nest-starter) (`.template-version`). The provider adapters, schema handling, pauses and error classification come from the old gateway of Atelier, which ran in prod from 2026-10-28.

Decisions of the owner (2026-11-08): OpenAI-compatible API; synchronous calls with a 16-minute budget plus jobs for long ones; one replica with the Codex login volume; a key per client; the journal keeps texts for 14 days; runs only on the VPS; every model the CLIs offer.

Subscriptions are for personal use: calls for other people need paid keys.

## What is inside

| Component                        | Version       | Why this one                                                                              |
| -------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| Node.js / pnpm                   | 26.13 / 12.16 | `.node-version`, `packageManager`                                                         |
| NestJS (express)                 | 12.3          | ESM; built-in `StandardSchemaValidationPipe` and `useSecurityHeaders()` (replaces helmet) |
| TypeScript                       | 7.0           | native `tsc` for build and typecheck; no Nest CLI, SWC only in tests                      |
| Zod                              | 4.6           | one schema for validation and OpenAPI; no class-validator or nestjs-zod                   |
| @nestjs/swagger                  | 12.0.5        | understands Standard JSON Schema from Zod                                                 |
| Drizzle ORM / drizzle-kit        | 0.45 / 0.31   | SQL migrations, typed queries; driver `pg` 8.23                                           |
| PostgreSQL                       | 18.6          | `uuidv7()` built in                                                                       |
| pino / nestjs-pino               | 10.4 / 5.3    | JSON logs with `requestId`                                                                |
| @prometheus-io/client            | 0.16          | prom-client, moved to the Prometheus organization                                         |
| @nestjs/terminus, @nestjs/config | 12.1, 12.0    | official Nest modules                                                                     |
| Vitest / Testcontainers          | 5.0 / 12.2    |                                                                                           |
| Biome                            | 2.6           | linter and formatter                                                                      |

Versions are pinned exactly. [Renovate](https://docs.renovatebot.com/) (`renovate.json`, the same policy in every repo) opens update PRs on Monday early morning (`Asia/Tbilisi`): one PR for all non-major updates, one per major, weekly lockfile maintenance. Releases younger than 3 days are skipped.

## Getting started

```sh
pnpm install
pnpm infra:up        # Postgres :5432 (app/app)
pnpm env:local       # .env from .env.example
pnpm db:migrate      # build + Drizzle migrations
pnpm dev             # http://localhost:4000, metrics http://localhost:9464/metrics
```

The rest:

```sh
pnpm verify          # lint + typecheck + build + test (Testcontainers need Docker)
pnpm test:unit       # no Docker
pnpm test:int        # Postgres in Testcontainers
pnpm start           # node dist/main.js after pnpm build
pnpm infra:down      # stop; pnpm infra:reset stops and deletes the data
```

Swagger UI: `/docs` (except with `NODE_ENV=production`), document: `/openapi.json`.

## API

Base URL for OpenAI SDKs: `http://llm-gateway.prod.svc/api/v1` with the client's key as the API key. Every route needs `Authorization: Bearer <key>`.

| Method and path                         | What                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/chat/completions`         | OpenAI chat completion. `model` from `/models`, `reasoning_effort` among the model's efforts (default: the model's), `response_format` `text` or `json_schema` (`json_object` and `stream` are refused), `metadata.purpose` names the call in the journal. `Idempotency-Key` returns the stored answer of a successful call for 24 h. Up to 16 minutes |
| `GET /api/v1/models`                    | the models this key may call, with `efforts` and `default_effort`                                                                                                                                                                                                                                                                                      |
| `POST /api/v1/jobs`                     | the same body; 202 with a job id at once, the call runs in the background                                                                                                                                                                                                                                                                              |
| `GET /api/v1/jobs/:id`                  | `queued`, `running`, `succeeded` (with `result`, a chat completion) or `failed` (with `error`); only the client that queued it                                                                                                                                                                                                                         |
| `GET /api/v1/providers`                 | admin keys: each provider's availability, pause, slots                                                                                                                                                                                                                                                                                                 |
| `DELETE /api/v1/providers/:id/pause`    | admin keys: lift a pause by hand                                                                                                                                                                                                                                                                                                                       |
| `GET /health/live`, `GET /health/ready` | ready: 503 without Postgres                                                                                                                                                                                                                                                                                                                            |
| `GET /openapi.json`, `GET /docs`        | OpenAPI                                                                                                                                                                                                                                                                                                                                                |

Errors of the model routes have the OpenAI shape `{ error: { message, type, code, param, retryable, resets_at } }`, with `code`: `bad_request` 400, `invalid_api_key` 401, `permission_denied` 403, `invalid_output` 422 (the answer missed the schema after a correction), `provider_quota` 429 (paused until `resets_at`, also in `Retry-After`), `provider_unavailable` 503 (`retryable: false` for a lost login), `provider_timeout` 504. Validation and database errors keep the service contract body.

Text answers go through a one-field schema internally (`{ content }`), so every provider answers the same way.

## Clients

`LLM_CLIENTS` lists the clients: name, SHA-256 of the key, allowed models (`*` for all), `admin`. The hashes are not secrets (ConfigMap); the key goes into the client's sealed secrets:

```sh
node scripts/client-key.mjs tailor-api '*' 2>/dev/null | kubectl create secret generic ...   # the key, never printed
node scripts/client-key.mjs tailor-api '*' >/dev/null                                       # the entry
```

Run it once per client and use both outputs of the same run.

## Models

`config/models.json`: the models and efforts of Codex CLI 0.165.0 (8 models, efforts `low` to `ultra`), Claude Code 2.1.308 (Fable, Opus, Sonnet, Haiku, `low` to `max`). A new CLI version is pinned in the Dockerfile only after a live call.

## Logins

- Codex: `codex login --device-auth` with `CODEX_HOME` on the login volume. The CLI refreshes its token in that folder, so the login belongs to one installation (one replica, D-105).
- Claude: `claude setup-token` gives `CLAUDE_CODE_OAUTH_TOKEN` (sealed secret).

A provider without its login answers 503 with the reason; `GET /api/v1/providers` shows it.

## Journal

`llm_calls`: client, purpose, model, effort, provider, account, tokens, time, outcome, the request messages with secrets masked and the answer. Calls and finished jobs older than `LLM_LOG_RETENTION_DAYS` (14) are deleted every 6 hours. Logs carry ids and numbers, never the texts.

## Add a capability

Each one is a copy from `nest-example`, wired in `app.module.ts`. Pick by need ("Which mechanism" in its README): a job for this service's own background work, an event to tell other services, a consumer to react to theirs. Do not add one "for later".

| Capability                                  | Copy from nest-example                                                                                                                                                                                                       | Also                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis (cache, rate limit)                   | `src/common/redis/`, `RedisModule` and `ThrottlerModule` in `app.module.ts`, `.claude/rules/redis.md`                                                                                                                        | `@redis/client`, `@nestjs/throttler`; `REDIS_URL` (`redisEnvSchema`); the `redis` service in `compose.yaml`; `RedisContainer` in `test/global-setup.ts`; `services: postgres,redis` in CI                      |
| Jobs (pg-boss)                              | `src/common/jobs/`, `JobsModule` in `app.module.ts`, the pg-boss part of `src/db/migrations.ts`, `src/notes/note-stats.job.ts` as the model, `.claude/rules/pg-boss.md`                                                      | `pg-boss`; nothing else: it runs in Postgres                                                                                                                                                                   |
| Events (RabbitMQ: outbox, inbox, consumers) | `src/common/messaging/`, `src/messaging/replay-dlq.ts`, `MessagingModule` in `app.module.ts`, `outbox`/`inbox` in `src/db/schema.ts`, `src/notes/notes.events.ts` and `src/activity/` as models, `.claude/rules/rabbitmq.md` | `amqplib`; `RABBITMQ_URL` (`rabbitEnvSchema`); the `rabbitmq` service in `compose.yaml`; `RabbitMQContainer` in `test/global-setup.ts`; `services: postgres,rabbitmq` in CI; the `messaging:replay-dlq` script |

Copy the tests of the capability too (`test/*.int.test.ts` of nest-example: `redis-degradation`, `messaging`, `broker-outage` and the helpers in `test/containers.ts`). The degradation metrics they export already have alerts in gitops (`platform/monitoring/rules/services.yaml`). A new secret goes to the service's SealedSecret.

## Time budgets

A dependency that hangs fails the request fast instead of filling the pool (service contract, "Time budgets"):

| Budget                               | Value                      | Where                                                                                               | When exceeded                                                                                           |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Whole request                        | 10 s                       | `RequestTimeoutInterceptor` (`src/common/http/request-timeout.ts`)                                  | 504 `TIMEOUT`; `http_server_request_timeouts_total`                                                     |
| SQL statement                        | 5 s                        | `statement_timeout`, a startup parameter of every pool connection (`DATABASE_TIMEOUTS`)             | 503 `UNAVAILABLE`                                                                                       |
| Waiting for a lock                   | 2 s                        | `lock_timeout` (row and table locks, e.g. a migration's `ALTER TABLE`)                              | 503 `UNAVAILABLE`                                                                                       |
| Transaction idle without a statement | 10 s                       | `idle_in_transaction_session_timeout`: the server ends a leaked transaction                         | the connection is closed and replaced                                                                   |
| Waiting for a pool connection        | 2 s                        | `connectionTimeoutMillis`; the pool is bounded by `DATABASE_POOL_MAX` (10)                          | 503 `UNAVAILABLE` ("Database is busy")                                                                  |
| Request body                         | 1 MiB                      | the JSON and urlencoded body parsers (`BODY_LIMIT` in `src/app.setup.ts`), also chunked             | 413 `PAYLOAD_TOO_LARGE`                                                                                 |
| Migration waiting for a lock         | 1 s per run, up to 10 runs | `lock_timeout` of the migration connection (`MIGRATION_LOCKS` in `src/common/database/database.ts`) | the run is rolled back and repeated after 1–10 s; after about 1 min the Job fails and the rollout stops |

503s from Postgres are logged with the reason only (never the SQL) and counted in `http_server_database_failures_total{reason}`; `db_pool_connections{state=total|idle|waiting}` shows the pool. Postgres also has a 6 s client reply deadline: a connection whose server never replies is closed and removed from the pool. Readiness (`/health/ready`) requires Postgres; a capability added later registers its own check, degradable ones with `required: false`.

## Migrations

`node dist/db/migrate.js` runs in the migrate Job before the new pods, while the old pods keep serving. So:

- **Compatible with the running code.** The old version runs during the Job, during the rollout and after a rollback. Add first (a column, a table, an index), switch the code in the next release, remove the old in the release after that. Never rename or drop in the same release that stops using it.
- **Forward only.** There are no down migrations; a rollback in gitops brings back the old image, which works with the new schema because of the rule above.
- **Short locks.** A DDL statement waiting for a lock holds up every later query on that table. The migration connection waits at most 1 s, below the app's 2 s, so the app's queries get through; the run (one transaction for every pending migration) is then rolled back and repeated, up to 10 times (`MIGRATION_LOCKS`, each retry logged). Once a statement holds its lock, it holds it until the end: a rewrite of a big table or an index on it is planned on its own, not mixed into a feature migration.
- **Data in batches.** Backfilling existing rows is a job, in batches, not an `UPDATE` of the whole table in the migration.

## Docker

```sh
docker build --build-arg APP_VERSION=$(git rev-parse HEAD) -t llm-gateway .
pnpm infra:up
# as in Kubernetes: read-only root filesystem, no capabilities, uid 10001
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user 10001:10001 --network llm-gateway_default -p 4000:3000 -p 9464:9464 \
  -e DATABASE_URL=postgres://app:app@postgres:5432/app llm-gateway
# migrations from the same image
docker run --rm --read-only --tmpfs /tmp --user 10001:10001 --network llm-gateway_default \
  -e DATABASE_URL=postgres://app:app@postgres:5432/app llm-gateway node dist/db/migrate.js
```

- Base `node:26.13.0-trixie-slim`. Stages: `deps` (pnpm from `packageManager`) → `build` (`dist/`) and `prod-deps` (`node_modules` without dev dependencies) → `runtime`.
- `APP_VERSION` is the only build arg: nothing environment-specific is baked in, so one image runs on stage and prod.
- App files are owned by root, the app runs as uid `10001` and writes nothing: a read-only root filesystem works, only `/tmp` is writable.
- `PORT` is 3000 in the image (the local default without it is 4000), metrics on `METRICS_PORT` 9464. `HEALTHCHECK` polls `/health/ready` for `docker run`; Kubernetes ignores it and uses its probes.
- `node dist/main.js` is PID 1. On `SIGTERM`: readiness answers 503 for `SHUTDOWN_DELAY_MS` (0 by default; the pod's `preStop` sleep drains the load balancer), then HTTP and the pool close. A hard deadline in `main.ts` exits with an error after 25 s, before Kubernetes kills the pod at 30 s.
- Behind an ingress set `TRUST_PROXY_HOPS=1`, or client IPs are the proxy's.

## CI

`.github/workflows/ci.yml` calls the org reusable workflows from `nick-lukashik/.github` by the moving major tag `@v1`, never `@master`:

- job `ci`: `build.yml@v1` with `kind: api` and `services: postgres`. It starts a Postgres service container, exports it as `TEST_DATABASE_URL`, runs `pnpm verify` and builds the image with `APP_VERSION=<full SHA>`; on `master` it pushes the image to GHCR and outputs its digest. A change to docs only (`docs/`, `.claude/`, `*.md` at the root) skips all of it. The required check is `ci / verify`. `publish` is on: this repository is not a template.
- job `deploy`: on `master`, when an image was pushed: `deploy-pr.yml@v1` opens the gitops PR with the new digest. Secrets are passed explicitly, never `secrets: inherit`.

`test/global-setup.ts` uses `TEST_DATABASE_URL` when it is set, else starts Postgres in Testcontainers. Plain `DATABASE_URL` is never used, because the tests truncate tables.

## Deploy

The image follows the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md) (kind **api**); it is the source of truth for everything below.

- Image: `ghcr.io/nick-lukashik/<repo-name>`, tags `sha-<7 chars>` and the full SHA, deployed by digest only. The same image goes to stage and then to prod.
- gitops: `apps/<svc>/prod/kustomization.yaml` includes `components/service` and `components/api`, sets the host, and has one `images:` entry `ghcr.io/nick-lukashik/<svc>` with a `digest`. The deploy PR changes only that digest.
- Config through `envFrom`: non-secret values (`LOG_LEVEL`, `TRUST_PROXY_HOPS`, `DATABASE_POOL_MAX`, …) in the ConfigMap `<svc>-config`; `DATABASE_URL` in the SealedSecret `<svc>-secrets`. `PORT=3000` comes from gitops; `APP_VERSION` from the image. A bad or missing value stops the process at start.
- Migrations: `components/api` runs `node dist/db/migrate.js` as an Argo CD `Sync`-hook Job in wave 0 with the same image, config and secrets: after `<svc>-secrets` (wave -1), before the Deployment (wave 1), so a failed migration stops the rollout. See "Migrations" for the rules a migration follows.
- Probes on the `http` port: `/health/live` (the process answers) and `/health/ready` (503 without Postgres). Both return `x-app-version`, which the post-deploy smoke check waits for.
- Metrics: Prometheus text on port `9464` (`METRICS_PORT`), path `/metrics`, scraped through the ServiceMonitor from `components/api`. Never on the public `http` port.
- Callers: only Traefik and pods labelled `nick-lukashik.com/api-client: "true"` (NetworkPolicy from `components/api`).

Conventions for agents and people: `AGENTS.md`; library rules: `.claude/rules/`.

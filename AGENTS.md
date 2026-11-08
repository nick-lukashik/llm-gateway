# AGENTS.md

The model gateway of the platform, created from `nest-starter`: every service calls models only through it. An OpenAI-compatible API (`/api/v1/chat/completions`, `/api/v1/models`) plus jobs for long calls, over the owner's subscriptions: Codex CLI, Claude Code CLI, MiniMax HTTP. One replica with the Codex login volume (an exception to the contract). Postgres keeps the call journal with texts (14 days), provider pauses and jobs. Redis, RabbitMQ (events through outbox/inbox) and pg-boss (jobs) are added only when the service uses them, copied from `nest-example` ("Add a capability" in `README.md`). The human-facing description is `README.md`.

## Commands

- `pnpm install`: dependencies (Node 26, pnpm 12; versions pinned exactly).
- `pnpm infra:up` / `pnpm infra:down` / `pnpm infra:reset`: Postgres 18 from `compose.yaml`.
- `pnpm env:local`: `.env` from `.env.example`; `pnpm db:migrate`: build and migrations; `pnpm dev`: build, `tsc --watch` and `node --watch`.
- `pnpm verify`: lint + typecheck + build + test. It must be green before you hand work over; report the command and its actual result.
- `pnpm test:unit` (no Docker), `pnpm test:int` (Testcontainers, needs Docker). Tests only through `vitest run`, never watch.
- `pnpm db:generate --name <what_it_changes>`: an SQL migration from `src/db/schema.ts`; read the generated SQL.
- `pnpm format`: Biome with fixes.

## Structure

- `src/main.ts`: entry point; `src/app.module.ts`: module wiring; `src/app.setup.ts`: HTTP setup (shared with the tests).
- `src/config/`: the Zod env schema (`env.ts`) and the `registerAs` groups (`config.ts`). Nothing else reads `process.env`.
- `src/common/`: infrastructure without business logic, identical to `nest-example` and ready to move into a package: `http` (errors, request id, cursors, validation), `database`, `health`, `metrics`, `logging`, `openapi`, `context` (AsyncLocalStorage). Change it in `nest-example` first, then copy it here.
- `src/db/`: Drizzle schema, types, `migrate.ts` (Argo CD Sync-hook Job before the Deployment: `node dist/db/migrate.js`).
- `src/domain/`: provider-independent logic ported from the old gateway: `json-schema.ts` (schema checks, Codex strict mode, draft 7), `coerce.ts`, `failures.ts` (error codes and the text classifier), `pause.ts` (reset time from limit messages), `semaphore.ts`, `models.ts` (the catalog `config/models.json`).
- `src/providers/`: Codex and Claude as CLI runs (`run-cli.ts`, an env allowlist in `provider.ts`), MiniMax over HTTP. A new CLI version can change the output they parse: pin it in the Dockerfile and check with a live call.
- `src/gateway/`: the API (`gateway.controller.ts`, OpenAI shapes in `openai.ts`), client keys (`clients.ts`), the call path with slots, pauses and the journal (`gateway.service.ts`), jobs and the purge (`jobs.service.ts`), SQL (`gateway.repository.ts`).
- `config/models.json`: models and efforts the CLIs offer; no secrets.
- `scripts/client-key.mjs`: a new client key (stdout) and its `LLM_CLIENTS` entry (stderr).
- `drizzle/`: SQL migrations and `meta/` (generated, never edited by hand).
- `test/`: integration tests and the harness; unit tests sit next to the code (`*.test.ts`).
- `Dockerfile`, `.github/workflows/ci.yml`: the image and CI follow the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md) (kind **api**); see "Deploy" in `README.md`.

## Conventions

- Code style is Biome's (`biome.json`): 4 spaces, single quotes, no `;`, lines up to 120 characters, objects and arrays always expanded, operators at the start of a wrapped line, `type` over `interface`, `string[]`, kebab-case file names. Run `pnpm format` after edits.
- ESM: relative imports end in `.js`. Injectable classes are imported as values, not `import type` (DI reads `emitDecoratorMetadata`). Non-classes go through a `Symbol` token (`DB`, `PG_POOL`).
- Controllers are thin: the schema on the parameter (`@Body({ schema })`, `@Query({ schema })`), a service call. SQL lives only in `*.repository.ts`.
- The contract is described by Zod schemas in `<feature>.schemas.ts` with `.meta({ id })`; OpenAPI (`/openapi.json`) is built from them. Responses through `@ApiOkResponse({ standardSchema })`, errors through `@ApiErrors(...)`.
- Errors: `throw new AppError(code, message, details?)` or `notFound("Job")`. Codes: `VALIDATION_FAILED` 400, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429 (once a rate limit is added), `INTERNAL` 500, `UNAVAILABLE` 503 (Postgres over a time budget or down: `ErrorFilter` maps it by SQLSTATE), `TIMEOUT` 504 (the 10 s request budget). Only `ErrorFilter` builds the response body; stacks, SQL and internal messages never leave the service.
- Time budgets (service contract), with the gateway's exceptions: the whole request 16 min (`GATEWAY_REQUEST_TIMEOUT_MS`, D-104), body 8 MiB (internal only); otherwise request 10 s, SQL statement 5 s, lock 2 s, idle in transaction 10 s, pool wait 2 s, migration lock wait 1 s (retried), body 1 MiB. They are set once (`DATABASE_TIMEOUTS`, `REQUEST_TIMEOUT_MS`, `BODY_LIMIT`); work that needs more goes to a job (pg-boss, see nest-example), not a longer budget.
- Degradation: readiness requires Postgres only. A dependency added later registers a check with `health.register(name, check, { required })`; a degradable one (Redis, RabbitMQ) uses `required: false`, is reported as `degraded`, never blocks startup, and has a metric for its degraded state.
- Migrations: compatible with the code that is running (add → switch → remove, over separate releases), forward only, no long-locking DDL mixed into a feature migration, backfills as batched jobs ("Migrations" in `README.md`).
- A new environment variable: `src/config/env.ts` → a group in `src/config/config.ts` → `.env.example`. Secrets have no `.default()`.
- Capabilities: add Redis, RabbitMQ or pg-boss only when a feature of this service needs it, by copying it from `nest-example` with its tests ("Add a capability" in `README.md`), never a stub "for later". Which one: a job for this service's own background work, an event to tell other services, a consumer with the inbox to react to theirs; not event → own job when the handler can do the work in its transaction ("Which mechanism" in nest-example's README).
- Logs: pino JSON, only `Logger` from `@nestjs/common`; the object first, a constant message. Secrets, tokens and personal data are never logged.
- Times in the API are ISO strings in UTC; ids are uuidv7 (`uuidv7()` in PostgreSQL 18, `randomUUIDv7()` in Node).
- Runtime: the app listens on `PORT` (local default 4000; the image and the cluster use 3000), metrics on `METRICS_PORT` (9464). The image runs as uid `10001` with a read-only root filesystem: write nothing outside `/tmp`.
- English everywhere: code, comments (short and rare) and docs.
- No secrets, real IPs or e-mail addresses in files (examples use `example.com`).

## Library rules

Short rules for each library, checked against the installed versions. Read the relevant file before changing code in that area.

- `.claude/rules/nestjs.md`: NestJS 12, @nestjs/config, terminus, throttler, swagger (NestJS llms.txt).
- Redis, RabbitMQ and pg-boss rules come with the capability: `.claude/rules/{redis,rabbitmq,pg-boss}.md` of nest-example.
- `.claude/rules/zod.md`: Zod 4 (Zod llms.txt).
- `.claude/rules/drizzle.md`: Drizzle ORM 0.45 and drizzle-kit 0.31 (Drizzle llms.txt).
- `.claude/rules/pino.md`: pino 10 and nestjs-pino 5 (docs summary).
- `.claude/rules/prometheus.md`: @prometheus-io/client (docs summary).
- `.claude/rules/vitest.md`: Vitest 5 (Vitest llms.txt and its guide for AI agents).
- `.claude/rules/testcontainers.md`: Testcontainers for Node 12 (docs summary).
- `.claude/rules/biome.md`: Biome 2 (docs summary).

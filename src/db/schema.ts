import { sql } from 'drizzle-orm'
import {
    bigint,
    boolean,
    date,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    unique,
    uuid,
} from 'drizzle-orm/pg-core'

/** Millisecond precision, so an ISO string from JSON round-trips exactly. */
const at = (name: string) =>
    timestamp(name, {
        withTimezone: true,
        precision: 3,
    })

/**
 * Every model call: who, what for, which model and account, tokens, time,
 * outcome, and the texts (request messages with secrets masked, the answer).
 * Deleted after LLM_LOG_RETENTION_DAYS (14, D-107).
 */
export const llmCalls = pgTable(
    'llm_calls',
    {
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        client: text('client').notNull(),
        purpose: text('purpose'),
        model: text('model').notNull(),
        effort: text('effort').notNull(),
        provider: text('provider').notNull(),
        account: text('account').notNull(),
        /** The client's Idempotency-Key: a repeated call returns the stored answer. */
        idempotencyKey: text('idempotency_key'),
        jobId: uuid('job_id'),
        /** `ok`, an error code, or `aborted` (the caller left). */
        outcome: text('outcome').notNull(),
        errorMessage: text('error_message'),
        tokensIn: integer('tokens_in'),
        tokensOut: integer('tokens_out'),
        durationMs: integer('duration_ms').notNull(),
        queueMs: integer('queue_ms').notNull(),
        corrected: boolean('corrected').notNull().default(false),
        request: jsonb('request').notNull(),
        response: jsonb('response'),
        createdAt: at('created_at').notNull().defaultNow(),
    },
    t => [
        index('llm_calls_created_at_idx').on(t.createdAt),
        index('llm_calls_idempotency_idx').on(t.client, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    ],
)

/** A provider account paused until its usage limit resets; survives restarts (atelier#61). */
export const providerPauses = pgTable(
    'provider_pauses',
    {
        provider: text('provider').notNull(),
        account: text('account').notNull(),
        until: at('until').notNull(),
        reason: text('reason').notNull(),
        updatedAt: at('updated_at').notNull().defaultNow(),
    },
    t => [
        primaryKey({
            columns: [
                t.provider,
                t.account,
            ],
        }),
    ],
)

/**
 * Long calls (D-104): what the client reads. pg-boss runs them (queue
 * `llm.call`, its job id is this row's id); `attempts` counts the starts, a
 * start cut off by a restart included.
 */
export const llmJobs = pgTable(
    'llm_jobs',
    {
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        client: text('client').notNull(),
        /** `queued`, `running`, `succeeded`, `failed`. */
        status: text('status').notNull().default('queued'),
        request: jsonb('request').notNull(),
        purpose: text('purpose'),
        result: jsonb('result'),
        error: jsonb('error'),
        attempts: integer('attempts').notNull().default(0),
        createdAt: at('created_at').notNull().defaultNow(),
        startedAt: at('started_at'),
        finishedAt: at('finished_at'),
    },
    t => [
        index('llm_jobs_status_created_at_idx').on(t.status, t.createdAt),
    ],
)

/**
 * Calls per UTC day, client, purpose, provider and model (D-168, D-177):
 * counts only, no texts, kept without the journal's retention. Recomputed from
 * llm_calls for the days the journal still holds in full (an idempotent
 * upsert, src/gateway/usage.repository.ts); older days stay as they were.
 */
export const llmUsageDaily = pgTable(
    'llm_usage_daily',
    {
        day: date('day', {
            mode: 'string',
        }).notNull(),
        client: text('client').notNull(),
        /** `metadata.purpose` of the calls; null for calls without one. */
        purpose: text('purpose'),
        provider: text('provider').notNull(),
        model: text('model').notNull(),
        calls: integer('calls').notNull(),
        /** Calls whose outcome is not `ok`: errors, refusals and calls the caller left. */
        errors: integer('errors').notNull(),
        tokensIn: bigint('tokens_in', {
            mode: 'number',
        }).notNull(),
        tokensOut: bigint('tokens_out', {
            mode: 'number',
        }).notNull(),
        /** Total time of the calls, slot waits included. */
        durationMs: bigint('duration_ms', {
            mode: 'number',
        }).notNull(),
        updatedAt: at('updated_at').notNull().defaultNow(),
    },
    t => [
        // A call without a purpose counts under one null key.
        unique('llm_usage_daily_key').on(t.day, t.client, t.purpose, t.provider, t.model).nullsNotDistinct(),
    ],
)

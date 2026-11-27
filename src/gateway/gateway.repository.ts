import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { DB } from '../common/database/database.js'
import { llmCalls, llmJobs, providerPauses } from '../db/schema.js'
import type { Db, NewCall, Tx } from '../db/types.js'

/** How long an Idempotency-Key returns the stored answer. */
export const IDEMPOTENCY_WINDOW_HOURS = 24

const UNFINISHED = [
    'queued',
    'running',
]

/** SQL of the gateway: the call journal, provider pauses and jobs. */
@Injectable()
export class GatewayRepository {
    constructor(@Inject(DB) private readonly db: Db) {}

    async recordCall(call: NewCall) {
        await this.db.insert(llmCalls).values(call)
    }

    /** The stored answer of a successful call with this key, if it is recent. */
    async answerFor(client: string, idempotencyKey: string): Promise<unknown | undefined> {
        const [row] = await this.db
            .select({
                response: llmCalls.response,
            })
            .from(llmCalls)
            .where(
                and(
                    eq(llmCalls.client, client),
                    eq(llmCalls.idempotencyKey, idempotencyKey),
                    eq(llmCalls.outcome, 'ok'),
                    gte(llmCalls.createdAt, sql`now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`),
                ),
            )
            .orderBy(desc(llmCalls.createdAt))
            .limit(1)
        return row?.response ?? undefined
    }

    pauses() {
        return this.db.select().from(providerPauses).where(gte(providerPauses.until, sql`now()`))
    }

    async savePause(provider: string, account: string, until: Date, reason: string) {
        await this.db
            .insert(providerPauses)
            .values({
                provider,
                account,
                until,
                reason,
            })
            .onConflictDoUpdate({
                target: [
                    providerPauses.provider,
                    providerPauses.account,
                ],
                set: {
                    until,
                    reason,
                    updatedAt: sql`now()`,
                },
            })
    }

    async deletePause(provider: string, account: string) {
        await this.db
            .delete(providerPauses)
            .where(and(eq(providerPauses.provider, provider), eq(providerPauses.account, account)))
    }

    /** Stores a queued job; `send` queues its pg-boss job in the same transaction: both or neither. */
    createJob(client: string, request: unknown, purpose: string | null, send: (tx: Tx, id: string) => Promise<void>) {
        return this.db.transaction(async tx => {
            const [row] = await tx
                .insert(llmJobs)
                .values({
                    client,
                    request,
                    purpose,
                })
                .returning()
            if (!row) throw new Error('insert into llm_jobs returned no row')
            await send(tx, row.id)
            return row
        })
    }

    async findJob(client: string, id: string) {
        const [row] = await this.db
            .select()
            .from(llmJobs)
            .where(and(eq(llmJobs.id, id), eq(llmJobs.client, client)))
            .limit(1)
        return row
    }

    /**
     * Marks an unfinished job running and counts the start. A job left
     * running by a stopped process is taken over: pg-boss runs one attempt
     * of a job at a time. Undefined when the job is finished or gone.
     */
    async claimJob(id: string) {
        const [row] = await this.db
            .update(llmJobs)
            .set({
                status: 'running',
                startedAt: sql`now()`,
                attempts: sql`${llmJobs.attempts} + 1`,
            })
            .where(and(eq(llmJobs.id, id), inArray(llmJobs.status, UNFINISHED)))
            .returning()
        return row
    }

    /** A start cut off by a shutdown: the job waits for its retry as queued. */
    async requeueJob(id: string) {
        await this.db
            .update(llmJobs)
            .set({
                status: 'queued',
                startedAt: null,
            })
            .where(and(eq(llmJobs.id, id), eq(llmJobs.status, 'running')))
    }

    /** Records the outcome once; a finished job stays as it is. True when this call finished it. */
    async finishJob(
        id: string,
        outcome:
            | {
                  result: unknown
              }
            | {
                  error: unknown
              },
    ) {
        const rows = await this.db
            .update(llmJobs)
            .set({
                status: 'result' in outcome ? 'succeeded' : 'failed',
                result: 'result' in outcome ? outcome.result : null,
                error: 'error' in outcome ? outcome.error : null,
                finishedAt: sql`now()`,
            })
            .where(and(eq(llmJobs.id, id), inArray(llmJobs.status, UNFINISHED)))
            .returning({
                id: llmJobs.id,
            })
        return rows.length > 0
    }

    /** Unfinished jobs, oldest first: each must have a pg-boss job (the release before pg-boss left some without). */
    unfinishedJobs(limit: number) {
        return this.db
            .select({
                id: llmJobs.id,
            })
            .from(llmJobs)
            .where(inArray(llmJobs.status, UNFINISHED))
            .orderBy(asc(llmJobs.createdAt))
            .limit(limit)
    }

    /** The answer of a successful call of this job: a start cut off after the call returns it instead of a new call. */
    async answerForJob(jobId: string): Promise<unknown | undefined> {
        const [row] = await this.db
            .select({
                response: llmCalls.response,
            })
            .from(llmCalls)
            .where(and(eq(llmCalls.jobId, jobId), eq(llmCalls.outcome, 'ok')))
            .orderBy(desc(llmCalls.createdAt))
            .limit(1)
        return row?.response ?? undefined
    }

    /** Deletes calls and finished jobs older than the retention, texts included. */
    async purge(days: number) {
        const cutoff = sql`now() - make_interval(days => ${days})`
        const calls = await this.db.delete(llmCalls).where(lt(llmCalls.createdAt, cutoff)).returning({
            id: llmCalls.id,
        })
        const jobs = await this.db
            .delete(llmJobs)
            .where(
                and(
                    lt(llmJobs.createdAt, cutoff),
                    inArray(llmJobs.status, [
                        'succeeded',
                        'failed',
                    ]),
                ),
            )
            .returning({
                id: llmJobs.id,
            })
        return {
            calls: calls.length,
            jobs: jobs.length,
        }
    }
}

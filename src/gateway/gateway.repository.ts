import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { DB } from '../common/database/database.js'
import { llmCalls, llmJobs, providerPauses } from '../db/schema.js'
import type { Db, NewCall } from '../db/types.js'

/** How long an Idempotency-Key returns the stored answer. */
export const IDEMPOTENCY_WINDOW_HOURS = 24

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

    async insertJob(client: string, request: unknown, purpose: string | null) {
        const [row] = await this.db
            .insert(llmJobs)
            .values({
                client,
                request,
                purpose,
            })
            .returning()
        if (!row) throw new Error('insert into llm_jobs returned no row')
        return row
    }

    async findJob(client: string, id: string) {
        const [row] = await this.db
            .select()
            .from(llmJobs)
            .where(and(eq(llmJobs.id, id), eq(llmJobs.client, client)))
            .limit(1)
        return row
    }

    /** Takes up to `limit` queued jobs, oldest first, and marks them running. */
    claimJobs(limit: number) {
        return this.db.transaction(async tx => {
            const queued = await tx
                .select({
                    id: llmJobs.id,
                })
                .from(llmJobs)
                .where(eq(llmJobs.status, 'queued'))
                .orderBy(asc(llmJobs.createdAt))
                .limit(limit)
                .for('update', {
                    skipLocked: true,
                })
            if (queued.length === 0) return []
            return tx
                .update(llmJobs)
                .set({
                    status: 'running',
                    startedAt: sql`now()`,
                    attempts: sql`${llmJobs.attempts} + 1`,
                })
                .where(
                    inArray(
                        llmJobs.id,
                        queued.map(job => job.id),
                    ),
                )
                .returning()
        })
    }

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
        await this.db
            .update(llmJobs)
            .set({
                status: 'result' in outcome ? 'succeeded' : 'failed',
                result: 'result' in outcome ? outcome.result : null,
                error: 'error' in outcome ? outcome.error : null,
                finishedAt: sql`now()`,
            })
            .where(eq(llmJobs.id, id))
    }

    /** One replica (D-105): a job running at startup died with the old process and goes back to the queue. */
    async requeueRunning() {
        const rows = await this.db
            .update(llmJobs)
            .set({
                status: 'queued',
                startedAt: null,
            })
            .where(eq(llmJobs.status, 'running'))
            .returning({
                id: llmJobs.id,
            })
        return rows.length
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

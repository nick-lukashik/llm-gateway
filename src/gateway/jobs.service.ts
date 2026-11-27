import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { fromDrizzle, type Job, PgBoss } from 'pg-boss'
import { z } from 'zod'
import { PG_BOSS } from '../common/jobs/jobs.module.js'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import { CallAborted, classifyFailure, LlmFailure } from '../domain/failures.js'
import type { Catalog } from '../domain/models.js'
import { ChatService } from './chat.service.js'
import { type Client, toClient } from './clients.js'
import { GatewayRepository } from './gateway.repository.js'
import { CATALOG, GatewayService } from './gateway.service.js'
import { GatewayMetrics } from './metrics.js'
import { type ChatCompletion, type ChatRequest, chatRequestSchema, errorBody } from './openai.js'

/** The pg-boss queue of the model calls; a job's id is its llm_jobs row id. */
export const CALL_QUEUE = 'llm.call'
/** Jobs out of attempts land here and their rows are marked failed. */
export const CALL_DEAD_QUEUE = 'llm.call.dead'

/** A start cut off by a shutdown, a crash or the expiry is retried twice: 3 starts, as before pg-boss. */
export const CALL_RETRY_LIMIT = 2
/** pg-boss fails a job whose worker stopped beating (a killed pod) and retries it. */
const HEARTBEAT_SECONDS = 30
/** Unfinished jobs checked for a pg-boss job at startup. */
const ADOPT_LIMIT = 1000

const jobDataSchema = z.object({
    jobId: z.uuid(),
})
type JobData = z.output<typeof jobDataSchema>

/**
 * Long calls as jobs (D-104, D-168, D-177) on pg-boss: a row in llm_jobs
 * (what the client reads) and a pg-boss job with the same id, queued in the
 * same transaction (what runs it), so queued and running jobs survive a
 * restart. Up to LLM_JOB_CONCURRENCY run at once, each still waiting for its
 * provider slot. A start cut off by a shutdown (pg-boss fails and aborts it),
 * a crash (missed heartbeats) or the expiry is retried; out of attempts the
 * row fails with `provider_unavailable`, retryable. A model failure is the
 * job's outcome and is not retried, as before.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationBootstrap {
    private readonly logger = new Logger('LlmJobs')

    constructor(
        private readonly chat: ChatService,
        private readonly gateway: GatewayService,
        private readonly repository: GatewayRepository,
        private readonly metrics: GatewayMetrics,
        @Inject(PG_BOSS) private readonly boss: PgBoss,
        @Inject(CATALOG) private readonly catalog: Catalog,
        @Inject(gatewayConfig.KEY) private readonly config: GatewayConfig,
    ) {}

    /** Queues exist before the first request can send to them; the dead-letter queue first. */
    async onModuleInit() {
        const timeouts = Object.values(this.catalog.providers).map(provider => provider?.timeoutMs ?? 0)
        // A start: the wait for a slot, then the call and its correction round within the provider timeout.
        const expireInSeconds = Math.ceil((this.config.queueTimeoutMs + Math.max(...timeouts)) / 1000) + 120
        await this.boss.createQueue(CALL_DEAD_QUEUE, {
            retryLimit: 5,
            retryDelay: 10,
            retryBackoff: true,
        })
        await this.boss.createQueue(CALL_QUEUE, {
            retryLimit: CALL_RETRY_LIMIT,
            retryDelay: 2,
            expireInSeconds,
            heartbeatSeconds: HEARTBEAT_SECONDS,
            deadLetter: CALL_DEAD_QUEUE,
        })
    }

    async onApplicationBootstrap() {
        await this.adopt()
        await this.boss.work<JobData>(
            CALL_QUEUE,
            {
                localConcurrency: this.config.jobConcurrency,
                pollingIntervalSeconds: 1,
            },
            async ([job]: Job<JobData>[]) => {
                if (job) await this.run(job)
            },
        )
        await this.boss.work<JobData>(CALL_DEAD_QUEUE, {}, async ([job]: Job<JobData>[]) => {
            if (job) await this.bury(job)
        })
    }

    /** Queues a job: the client's rights, its daily limit and the request shape are checked first. */
    async enqueue(client: Client, request: ChatRequest) {
        this.chat.prepare(client, request)
        await this.gateway.refuseOverLimit(client.name, client.dailyTokens)
        return this.repository.createJob(client.name, request, request.metadata?.purpose ?? null, async (tx, id) => {
            await this.boss.send(
                CALL_QUEUE,
                {
                    jobId: id,
                } satisfies JobData,
                {
                    id,
                    db: fromDrizzle(tx, sql),
                },
            )
        })
    }

    find(client: Client, id: string) {
        return this.repository.findJob(client.name, id)
    }

    /**
     * Every unfinished job has a pg-boss job: a send with the row's id is a
     * no-op when one exists. Picks up the jobs the release before pg-boss
     * queued (or left running when it stopped).
     */
    private async adopt() {
        let adopted = 0
        for (const row of await this.repository.unfinishedJobs(ADOPT_LIMIT)) {
            const sent = await this.boss.send(
                CALL_QUEUE,
                {
                    jobId: row.id,
                } satisfies JobData,
                {
                    id: row.id,
                },
            )
            if (sent) adopted++
        }
        if (adopted > 0)
            this.logger.warn(
                {
                    adopted,
                },
                'Unfinished jobs without a pg-boss job were queued',
            )
    }

    /** The client as configured now: a key removed from LLM_CLIENTS takes its queued jobs with it. */
    private clientOf(name: string): Client | null {
        const entry = this.config.clients.find(client => client.name === name)
        return entry ? toClient(entry) : null
    }

    private async run(job: Job<JobData>) {
        const data = jobDataSchema.safeParse(job.data)
        if (!data.success) {
            this.logger.error(
                {
                    bossJobId: job.id,
                },
                'Job data is invalid, dropped',
            )
            return
        }
        const { jobId } = data.data
        const row = await this.repository.claimJob(jobId)
        // Finished already (a repeat after its outcome was stored) or deleted.
        if (!row) return
        const log = {
            jobId,
            attempt: row.attempts,
        }
        const finish = async (outcome: ChatCompletion | LlmFailure) => {
            const failed = outcome instanceof LlmFailure
            const done = await this.repository.finishJob(
                jobId,
                failed
                    ? {
                          error: errorBody(outcome).error,
                      }
                    : {
                          result: outcome,
                      },
            )
            if (done) this.metrics.job(failed ? 'failed' : 'succeeded')
        }

        const request = chatRequestSchema.safeParse(row.request)
        if (!request.success) return finish(new LlmFailure('bad_request', 'The stored request is invalid'))
        const client = this.clientOf(row.client)
        if (!client) return finish(new LlmFailure('bad_request', `Client ${row.client} is no longer configured`))
        // A start cut off after its call succeeded: the journal has the answer, no second call.
        const stored = await this.repository.answerForJob(jobId)
        if (stored) return finish(stored as ChatCompletion)

        this.logger.log(log, 'Job started')
        try {
            const result = await this.chat.complete(client, request.data, {
                jobId,
                signal: job.signal,
            })
            await finish(result)
        } catch (error) {
            if (error instanceof CallAborted || job.signal.aborted) {
                // pg-boss failed it (shutdown, expiry): it retries it, or sends it to the dead queue.
                await this.repository.requeueJob(jobId)
                this.metrics.job('interrupted')
                this.logger.warn(log, 'Job interrupted, it will be retried')
                throw error instanceof CallAborted ? error : new CallAborted()
            }
            await finish(classifyFailure(error, 'job'))
        }
    }

    /** Out of attempts: the row is marked failed for its client to see. */
    private async bury(job: Job<JobData>) {
        const data = jobDataSchema.safeParse(job.data)
        if (!data.success) return
        const done = await this.repository.finishJob(data.data.jobId, {
            error: errorBody(
                new LlmFailure(
                    'provider_unavailable',
                    'The job was cut off by restarts too many times; send it again',
                    {
                        retryable: true,
                    },
                ),
            ).error,
        })
        if (!done) return
        this.metrics.job('dead')
        this.logger.warn(
            {
                jobId: data.data.jobId,
            },
            'Job out of attempts, marked failed',
        )
    }
}

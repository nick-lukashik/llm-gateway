import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import type { JobRow } from '../db/types.js'
import { CallAborted, classifyFailure, LlmFailure } from '../domain/failures.js'
import { ChatService } from './chat.service.js'
import type { Client } from './clients.js'
import { GatewayRepository } from './gateway.repository.js'
import { type ChatRequest, chatRequestSchema, errorBody } from './openai.js'

/** How often the runner looks for queued jobs besides the nudge on each new one. */
const POLL_MS = 2000
/** A job interrupted by this many restarts fails instead of looping. */
const MAX_ATTEMPTS = 3
/** How often old calls and jobs are purged. */
const PURGE_MS = 6 * 60 * 60 * 1000

/**
 * Long calls as jobs (D-104): stored in Postgres, run by this process (one
 * replica, D-105) up to LLM_JOB_CONCURRENCY at once, each still waiting for
 * its provider slot. A job running when the process stopped goes back to the
 * queue at startup. Also purges the journal after the retention (D-107).
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger('LlmJobs')
    private readonly running = new Map<string, AbortController>()
    private poll?: NodeJS.Timeout
    private purgeTimer?: NodeJS.Timeout
    private pumping = false
    private stopped = false

    constructor(
        private readonly chat: ChatService,
        private readonly repository: GatewayRepository,
        @Inject(gatewayConfig.KEY) private readonly config: GatewayConfig,
    ) {}

    async onApplicationBootstrap() {
        const requeued = await this.repository.requeueRunning()
        if (requeued > 0)
            this.logger.warn(
                {
                    requeued,
                },
                'Jobs interrupted by a restart went back to the queue',
            )
        this.poll = setInterval(() => this.pump(), POLL_MS)
        this.purgeTimer = setInterval(() => void this.purge(), PURGE_MS)
        void this.purge()
        this.pump()
    }

    onApplicationShutdown() {
        this.stopped = true
        clearInterval(this.poll)
        clearInterval(this.purgeTimer)
        // Interrupted jobs are requeued by the next process.
        for (const controller of this.running.values()) controller.abort()
    }

    /** Queues a job; the client's rights and the request shape are checked before it is stored. */
    async enqueue(client: Client, request: ChatRequest) {
        this.chat.prepare(client, request)
        const job = await this.repository.insertJob(client.name, request, request.metadata?.purpose ?? null)
        this.pump()
        return job
    }

    find(client: Client, id: string) {
        return this.repository.findJob(client.name, id)
    }

    /** Starts as many queued jobs as there are free places. */
    pump() {
        if (this.pumping || this.stopped) return
        const free = this.config.jobConcurrency - this.running.size
        if (free <= 0) return
        this.pumping = true
        this.repository
            .claimJobs(free)
            .then(jobs => {
                for (const job of jobs) void this.runJob(job)
            })
            .catch((err: unknown) =>
                this.logger.error(
                    {
                        err,
                    },
                    'Job claim failed',
                ),
            )
            .finally(() => {
                this.pumping = false
            })
    }

    private async runJob(job: JobRow) {
        const controller = new AbortController()
        this.running.set(job.id, controller)
        try {
            if (job.attempts > MAX_ATTEMPTS) {
                await this.repository.finishJob(job.id, {
                    error: errorBody(
                        new LlmFailure('provider_unavailable', `Stopped by ${MAX_ATTEMPTS} restarts; send it again`, {
                            retryable: true,
                        }),
                    ).error,
                })
                return
            }
            const request = chatRequestSchema.parse(job.request)
            const client = {
                name: job.client,
                models: [
                    '*',
                ],
                admin: false,
            }
            const result = await this.chat.complete(client, request, {
                jobId: job.id,
                signal: controller.signal,
            })
            await this.repository.finishJob(job.id, {
                result,
            })
        } catch (error) {
            // Stopped by shutdown: stays running, the next process requeues it.
            if (error instanceof CallAborted || this.stopped) return
            await this.repository
                .finishJob(job.id, {
                    error: errorBody(classifyFailure(error, 'job')).error,
                })
                .catch((err: unknown) =>
                    this.logger.error(
                        {
                            err,
                            jobId: job.id,
                        },
                        'Job finish failed',
                    ),
                )
        } finally {
            this.running.delete(job.id)
            this.pump()
        }
    }

    private async purge() {
        try {
            const deleted = await this.repository.purge(this.config.retentionDays)
            if (deleted.calls > 0 || deleted.jobs > 0)
                this.logger.log(
                    {
                        ...deleted,
                        days: this.config.retentionDays,
                    },
                    'Journal purged',
                )
        } catch (err) {
            this.logger.error(
                {
                    err,
                },
                'Journal purge failed',
            )
        }
    }
}

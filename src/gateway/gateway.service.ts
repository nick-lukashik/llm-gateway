import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import { CallAborted, classifyFailure, LlmFailure } from '../domain/failures.js'
import { assertSupportedSchema, SchemaError, type SchemaObject, validateJson } from '../domain/json-schema.js'
import {
    type Catalog,
    type CatalogModel,
    type Effort,
    type Profile,
    type ProviderId,
    profileOf,
} from '../domain/models.js'
import { pauseSeconds } from '../domain/pause.js'
import { Semaphore } from '../domain/semaphore.js'
import { type GenerateCall, LLM_PROVIDERS, type LlmProvider, type ProviderResult } from '../providers/provider.js'
import { GatewayRepository } from './gateway.repository.js'
import { GatewayMetrics } from './metrics.js'

/** The loaded model catalog. */
export const CATALOG = Symbol('CATALOG')

type Pause = {
    until: Date
    reason: string
}

/** One call as the gateway runs it, whatever API it came through. */
export type CallRequest = {
    client: string
    purpose: string | null
    model: CatalogModel
    effort: Effort
    system: string
    input: string
    schema: SchemaObject
    /** What the journal keeps of the request: messages with secrets masked. */
    journal: unknown
    idempotencyKey: string | null
    jobId: string | null
    timeoutMs?: number
}

export type CallResult = ProviderResult & {
    provider: ProviderId
    profile: Profile
    corrected: boolean
    ms: number
}

export type ProviderStatus = {
    id: ProviderId
    account: string
    available: boolean
    reason: string | null
    pausedUntil: string | null
    concurrency: number
    inFlight: number
    waiting: number
}

/** A correction round needs at least this much of the time budget left. */
const MIN_CORRECTION_MS = 5000

const addTokens = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))

/**
 * One way to every model: refuses a paused or unavailable provider at once,
 * queues for one of the account's slots, runs the call, checks the answer
 * against the schema (one correction round), pauses the account after a
 * usage limit (kept in Postgres: a restart remembers it) and writes the
 * journal row with the texts. Logs carry ids, model, time, tokens and the
 * error code, never the texts.
 */
@Injectable()
export class GatewayService implements OnModuleInit {
    private readonly logger = new Logger('LlmGateway')
    private readonly providers = new Map<ProviderId, LlmProvider>()
    private readonly slots = new Map<ProviderId, Semaphore>()
    private readonly pauses = new Map<ProviderId, Pause>()

    constructor(
        @Inject(CATALOG) private readonly catalog: Catalog,
        @Inject(LLM_PROVIDERS) providers: LlmProvider[],
        @Inject(gatewayConfig.KEY) private readonly config: GatewayConfig,
        private readonly repository: GatewayRepository,
        private readonly metrics: GatewayMetrics,
    ) {
        for (const provider of providers) {
            const settings = catalog.providers[provider.id]
            if (!settings) continue
            this.providers.set(provider.id, provider)
            this.slots.set(provider.id, new Semaphore(settings.concurrency))
        }
        metrics.watch(() =>
            [
                ...this.slots,
            ].map(([id, slots]) => ({
                id,
                inFlight: slots.inFlight,
                waiting: slots.waiting,
                paused: this.pauseOf(id) !== null,
            })),
        )
    }

    async onModuleInit() {
        for (const row of await this.repository.pauses()) {
            if (row.account !== this.config.account || !this.providers.has(row.provider as ProviderId)) continue
            this.pauses.set(row.provider as ProviderId, {
                until: row.until,
                reason: row.reason,
            })
        }
    }

    models(): CatalogModel[] {
        return this.catalog.models
    }

    model(id: string): CatalogModel | undefined {
        return this.catalog.models.find(model => model.id === id)
    }

    providerList(): ProviderStatus[] {
        return [
            ...this.providers.keys(),
        ].map(id => this.statusOf(id))
    }

    /** Lifts a pause by hand (a limit reset earlier than announced). */
    async resume(id: string): Promise<ProviderStatus | null> {
        const provider = id as ProviderId
        if (!this.providers.has(provider)) return null
        this.pauses.delete(provider)
        await this.repository.deletePause(provider, this.config.account)
        this.logger.log(
            {
                provider,
            },
            'Provider pause lifted by hand',
        )
        return this.statusOf(provider)
    }

    /**
     * Runs one call and writes its journal row; `respond` builds the answer
     * the client gets, which the journal keeps for idempotent repeats.
     */
    async generate<T>(request: CallRequest, signal: AbortSignal, respond: (result: CallResult) => T): Promise<T> {
        const started = performance.now()
        const profile = profileOf(request.model, request.effort)
        const log = {
            client: request.client,
            purpose: request.purpose,
            model: profile.id,
            provider: profile.provider,
            jobId: request.jobId,
        }
        const journal = {
            client: request.client,
            purpose: request.purpose,
            model: request.model.id,
            effort: request.effort,
            provider: profile.provider,
            account: this.config.account,
            idempotencyKey: request.idempotencyKey,
            jobId: request.jobId,
            request: request.journal,
        }
        let queueMs = 0
        try {
            try {
                assertSupportedSchema(request.schema)
            } catch (error) {
                if (error instanceof SchemaError)
                    throw new LlmFailure('bad_request', `Unusable schema: ${error.message}`)
                throw error
            }
            const provider = this.providers.get(profile.provider)
            const slots = this.slots.get(profile.provider)
            const settings = this.catalog.providers[profile.provider]
            if (!provider || !slots || !settings)
                throw new LlmFailure('provider_unavailable', `No provider ${profile.provider}`, {
                    retryable: false,
                })
            const unavailable = provider.availability()
            if (unavailable)
                throw new LlmFailure('provider_unavailable', unavailable, {
                    retryable: false,
                })
            this.refuseIfPaused(profile.provider)

            const queued = performance.now()
            const release = await slots.acquire({
                maxWaitMs: this.config.queueTimeoutMs,
                signal,
                onTimeout: () =>
                    new LlmFailure(
                        'provider_unavailable',
                        `Timed out waiting ${Math.round(this.config.queueTimeoutMs / 1000)} s for a ${profile.provider} slot`,
                    ),
            })
            queueMs = Math.round(performance.now() - queued)
            this.metrics.waited(profile.provider, queueMs / 1000)
            try {
                this.refuseIfPaused(profile.provider)
                const result = await this.run(provider, {
                    profile,
                    settings,
                    system: request.system,
                    input: request.input,
                    schema: request.schema,
                    timeoutMs: request.timeoutMs ?? settings.timeoutMs,
                    signal,
                })
                const ms = Math.round(performance.now() - started)
                this.metrics.finished(profile.provider, profile.id, 'ok', ms / 1000)
                const answer = respond({
                    ...result,
                    provider: profile.provider,
                    profile,
                    ms,
                })
                this.logger.log(
                    {
                        ...log,
                        ms,
                        queueMs,
                        tokensIn: result.inputTokens,
                        tokensOut: result.outputTokens,
                        corrected: result.corrected,
                    },
                    'Generation succeeded',
                )
                await this.journal({
                    ...journal,
                    outcome: 'ok',
                    tokensIn: result.inputTokens,
                    tokensOut: result.outputTokens,
                    durationMs: ms,
                    queueMs,
                    corrected: result.corrected,
                    response: answer,
                })
                return answer
            } finally {
                release()
            }
        } catch (error) {
            const ms = Math.round(performance.now() - started)
            if (error instanceof CallAborted || signal.aborted) {
                this.metrics.finished(profile.provider, profile.id, 'aborted', ms / 1000)
                this.logger.log(
                    {
                        ...log,
                        ms,
                        queueMs,
                        error: 'aborted',
                    },
                    'Generation aborted',
                )
                await this.journal({
                    ...journal,
                    outcome: 'aborted',
                    durationMs: ms,
                    queueMs,
                })
                throw error instanceof CallAborted ? error : new CallAborted()
            }
            const failure = classifyFailure(error, profile.provider)
            if (failure.code === 'provider_quota' && failure.resetsAt === null)
                failure.resetsAt = await this.pause(profile.provider, failure.message)
            this.metrics.finished(profile.provider, profile.id, failure.code, ms / 1000)
            const line = {
                ...log,
                ms,
                queueMs,
                error: failure.code,
                retryable: failure.retryable,
                resetsAt: failure.resetsAt?.toISOString() ?? null,
            }
            if (failure.code === 'bad_request' || failure.code === 'provider_quota')
                this.logger.log(line, 'Generation refused')
            else this.logger.warn(line, 'Generation failed')
            await this.journal({
                ...journal,
                outcome: failure.code,
                errorMessage: failure.message,
                durationMs: ms,
                queueMs,
            })
            throw failure
        }
    }

    /** The journal must not fail a call that already has its answer. */
    private async journal(row: Parameters<GatewayRepository['recordCall']>[0]) {
        try {
            await this.repository.recordCall(row)
        } catch (err) {
            this.logger.error(
                {
                    err,
                    client: row.client,
                    model: row.model,
                },
                'Journal write failed',
            )
        }
    }

    /** The call and, if its answer fails the schema, one correction round. */
    private async run(
        provider: LlmProvider,
        call: GenerateCall,
    ): Promise<
        ProviderResult & {
            corrected: boolean
        }
    > {
        const deadline = Date.now() + call.timeoutMs
        const first = await provider.generate(call)
        this.metrics.spent(provider.id, first.inputTokens, first.outputTokens)
        const errors = this.check(first.output, call)
        if (errors.length === 0)
            return {
                ...first,
                corrected: false,
            }

        const remaining = deadline - Date.now()
        if (remaining < MIN_CORRECTION_MS) {
            this.metrics.corrected(provider.id, false)
            throw this.invalid(errors)
        }
        const second = await provider.generate({
            ...call,
            timeoutMs: remaining,
            correction: {
                output: first.output,
                errors,
                transcript: first.transcript,
            },
        })
        this.metrics.spent(provider.id, second.inputTokens, second.outputTokens)
        const left = this.check(second.output, call)
        this.metrics.corrected(provider.id, left.length === 0)
        if (left.length > 0) throw this.invalid(left)
        return {
            ...second,
            inputTokens: addTokens(first.inputTokens, second.inputTokens),
            outputTokens: addTokens(first.outputTokens, second.outputTokens),
            corrected: true,
        }
    }

    private check(output: unknown, call: GenerateCall) {
        try {
            return validateJson(output, call.schema)
        } catch (error) {
            if (error instanceof SchemaError) throw new LlmFailure('bad_request', `Unusable schema: ${error.message}`)
            throw error
        }
    }

    private invalid(errors: string[]) {
        return new LlmFailure(
            'invalid_output',
            `The answer does not match the schema after a correction: ${errors.join('; ')}`,
        )
    }

    private pauseOf(id: ProviderId): Pause | null {
        const pause = this.pauses.get(id)
        if (!pause) return null
        if (pause.until <= new Date()) {
            this.pauses.delete(id)
            return null
        }
        return pause
    }

    private refuseIfPaused(id: ProviderId) {
        const pause = this.pauseOf(id)
        if (pause)
            throw new LlmFailure('provider_quota', `${id} is paused: ${pause.reason}`, {
                resetsAt: pause.until,
            })
    }

    /** Pauses the account until the reset its message names; queued calls are refused now. */
    private async pause(provider: ProviderId, message: string): Promise<Date> {
        const now = new Date()
        const seconds = pauseSeconds(message, now, this.config.quotaPauseSeconds)
        const until = new Date(now.getTime() + seconds * 1000)
        const current = this.pauses.get(provider)
        const pause =
            current && current.until > until
                ? current
                : {
                      until,
                      reason: message.slice(0, 500),
                  }
        this.pauses.set(provider, pause)
        try {
            await this.repository.savePause(provider, this.config.account, pause.until, pause.reason)
        } catch (err) {
            this.logger.error(
                {
                    err,
                    provider,
                },
                'Pause write failed',
            )
        }
        this.logger.warn(
            {
                provider,
                until: pause.until.toISOString(),
                seconds,
            },
            'Provider paused after a usage limit',
        )
        this.slots.get(provider)?.rejectWaiting(
            () =>
                new LlmFailure('provider_quota', `${provider} is paused: ${pause.reason}`, {
                    resetsAt: pause.until,
                }),
        )
        return pause.until
    }

    private statusOf(id: ProviderId): ProviderStatus {
        const provider = this.providers.get(id)
        const slots = this.slots.get(id)
        const unavailable = provider ? provider.availability() : 'Not configured'
        const pause = this.pauseOf(id)
        return {
            id,
            account: this.config.account,
            available: unavailable === null && pause === null,
            reason: unavailable ?? (pause ? `Paused after a usage limit: ${pause.reason}` : null),
            pausedUntil: pause?.until.toISOString() ?? null,
            concurrency: slots?.limit ?? 1,
            inFlight: slots?.inFlight ?? 0,
            waiting: slots?.waiting ?? 0,
        }
    }
}

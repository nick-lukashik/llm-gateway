import { Injectable } from '@nestjs/common'
import type { Counter, Histogram } from '@prometheus-io/client'
import { Metrics } from '../common/metrics/metrics.js'
import type { LlmErrorCode } from '../domain/failures.js'

/** How a generation ended: `ok`, a contract error code, or `aborted` (the caller left). */
export type Outcome = 'ok' | LlmErrorCode | 'aborted'

export type ProviderState = {
    id: string
    inFlight: number
    waiting: number
    paused: boolean
}

/** Labels are provider ids, `<model>@<effort>` from the catalog and outcomes: small fixed sets. */
@Injectable()
export class GatewayMetrics {
    private readonly calls: Counter<'provider' | 'profile' | 'outcome'>
    private readonly duration: Histogram<'provider' | 'outcome'>
    private readonly queueWait: Histogram<'provider'>
    private readonly tokens: Counter<'provider' | 'direction'>
    private readonly corrections: Counter<'provider' | 'result'>
    private state: () => ProviderState[] = () => []

    constructor(metrics: Metrics) {
        this.calls = metrics.counter({
            name: 'llm_gateway_generations_total',
            help: 'Generations by provider, profile and outcome: ok, provider_quota, provider_unavailable, provider_timeout, invalid_output, bad_request, aborted (the caller left).',
            labelNames: [
                'provider',
                'profile',
                'outcome',
            ],
        })
        this.duration = metrics.histogram({
            name: 'llm_gateway_generation_duration_seconds',
            help: 'Time of a generation from the request to the answer, queue included.',
            labelNames: [
                'provider',
                'outcome',
            ],
            buckets: [
                1,
                5,
                10,
                30,
                60,
                120,
                300,
                600,
                900,
                1800,
                3600,
            ],
        })
        this.queueWait = metrics.histogram({
            name: 'llm_gateway_queue_wait_seconds',
            help: 'Wait for a free provider slot.',
            labelNames: [
                'provider',
            ],
            buckets: [
                0.01,
                1,
                5,
                30,
                60,
                300,
                900,
            ],
        })
        this.tokens = metrics.counter({
            name: 'llm_gateway_tokens_total',
            help: 'Model tokens by provider and direction: in (prompt) and out (answer).',
            labelNames: [
                'provider',
                'direction',
            ],
        })
        this.corrections = metrics.counter({
            name: 'llm_gateway_corrections_total',
            help: 'Correction rounds after an answer that failed the schema, by result: fixed or failed.',
            labelNames: [
                'provider',
                'result',
            ],
        })
        const gauge = (name: string, help: string, value: (state: ProviderState) => number) => {
            const read = () => this.state()
            metrics.gauge({
                name,
                help,
                labelNames: [
                    'provider',
                ],
                collect() {
                    this.reset()
                    for (const state of read())
                        this.set(
                            {
                                provider: state.id,
                            },
                            value(state),
                        )
                },
            })
        }
        gauge('llm_gateway_in_flight', 'Provider calls running now.', s => s.inFlight)
        gauge('llm_gateway_queued', 'Calls waiting for a provider slot.', s => s.waiting)
        gauge('llm_gateway_paused', '1 while a provider is paused after a usage limit.', s => (s.paused ? 1 : 0))
    }

    /** Where the gauges read the providers' state at scrape time. */
    watch(state: () => ProviderState[]) {
        this.state = state
    }

    finished(provider: string, profile: string, outcome: Outcome, seconds: number) {
        this.calls.inc({
            provider,
            profile,
            outcome,
        })
        this.duration.observe(
            {
                provider,
                outcome,
            },
            seconds,
        )
    }

    waited(provider: string, seconds: number) {
        this.queueWait.observe(
            {
                provider,
            },
            seconds,
        )
    }

    spent(provider: string, input: number | null, output: number | null) {
        if (input)
            this.tokens.inc(
                {
                    provider,
                    direction: 'in',
                },
                input,
            )
        if (output)
            this.tokens.inc(
                {
                    provider,
                    direction: 'out',
                },
                output,
            )
    }

    corrected(provider: string, fixed: boolean) {
        this.corrections.inc({
            provider,
            result: fixed ? 'fixed' : 'failed',
        })
    }
}

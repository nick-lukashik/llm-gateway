import type { ProviderId } from '../domain/models.js'
import type { GenerateCall, LlmProvider, ProviderResult } from '../providers/provider.js'

type Step = (call: GenerateCall) => Promise<ProviderResult> | ProviderResult

/** A provider that answers from a script of steps; the default step returns `{ ok: true }`. */
export class FakeProvider implements LlmProvider {
    readonly calls: GenerateCall[] = []
    readonly steps: Step[] = []
    unavailable: string | null = null

    constructor(readonly id: ProviderId) {}

    availability() {
        return this.unavailable
    }

    queue(...steps: Step[]) {
        this.steps.push(...steps)
        return this
    }

    async generate(call: GenerateCall): Promise<ProviderResult> {
        this.calls.push(call)
        const step = this.steps.shift()
        if (step) return step(call)
        return {
            output: {
                ok: true,
            },
            model: call.profile.model,
            inputTokens: 10,
            outputTokens: 2,
        }
    }

    reset() {
        this.calls.length = 0
        this.steps.length = 0
        this.unavailable = null
    }
}

/** A step that waits until `release()` (or the caller leaves) before answering. */
export function blocked() {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
        release = resolve
    })
    const step: Step = async call => {
        await new Promise<void>((resolve, reject) => {
            gate.then(resolve)
            call.signal.addEventListener('abort', () => reject(call.signal.reason), {
                once: true,
            })
        })
        return {
            output: {
                ok: true,
            },
            model: call.profile.model,
            inputTokens: 1,
            outputTokens: 1,
        }
    }
    return {
        step,
        release,
    }
}

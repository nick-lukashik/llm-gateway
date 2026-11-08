/** Error codes of the gateway; the OpenAI-shaped body carries them in `error.code`. */
export const llmErrorCodes = [
    'provider_quota',
    'provider_unavailable',
    'provider_timeout',
    'invalid_output',
    'bad_request',
] as const
export type LlmErrorCode = (typeof llmErrorCodes)[number]

export type LlmError = {
    error: LlmErrorCode
    retryable: boolean
    message: string
    resetsAt: string | null
}

/** HTTP status of each gateway error. */
export const statusOf: Record<LlmErrorCode, number> = {
    bad_request: 400,
    invalid_output: 422,
    provider_quota: 429,
    provider_unavailable: 503,
    provider_timeout: 504,
}

const retryableByDefault: Record<LlmErrorCode, boolean> = {
    bad_request: false,
    invalid_output: false,
    // Retry after resetsAt, not now.
    provider_quota: false,
    provider_unavailable: true,
    provider_timeout: true,
}

/**
 * A failed generation with its contract code. The message names what went
 * wrong (provider wording, schema paths); it never quotes the prompt.
 */
export class LlmFailure extends Error {
    readonly retryable: boolean
    resetsAt: Date | null

    constructor(
        readonly code: LlmErrorCode,
        message: string,
        options: {
            retryable?: boolean
            resetsAt?: Date | null
            cause?: unknown
        } = {},
    ) {
        super(message.slice(0, 2000), {
            cause: options.cause,
        })
        this.name = 'LlmFailure'
        this.retryable = options.retryable ?? retryableByDefault[code]
        this.resetsAt = options.resetsAt ?? null
    }

    get status() {
        return statusOf[this.code]
    }

    toBody(): LlmError {
        return {
            error: this.code,
            retryable: this.retryable,
            message: this.message,
            resetsAt: this.resetsAt?.toISOString() ?? null,
        }
    }
}

/** The caller went away (connection closed); nothing is sent back. */
export class CallAborted extends Error {
    constructor() {
        super('The caller closed the connection')
        this.name = 'CallAborted'
    }
}

const QUOTA =
    /usage limit|quota|rate.?limit|insufficient (?:balance|credits)|credit balance|too many requests|hit your [\w ]*limit|spend limit|\b(?:http|status|code)\W{0,3}429\b/i
const BAD_SCHEMA = /invalid[_ ]json[_ ]schema|invalid schema for|schema.*(?:not supported|is invalid)/i
const AUTH =
    /\b401\b|\b403\b|unauthori[sz]ed|forbidden|not logged in|\/login|log ?in again|authenticat|refresh token|invalid api key|token (?:has )?(?:expired|been revoked)/i
const TIMEOUT = /timeout|timed out|TimeoutError|AbortError/i

/**
 * Turns any provider error into a gateway failure, by the provider's own
 * wording (Codex and Claude report everything as text): a limit pauses the
 * provider, a lost login is not retried, the rest may be.
 */
export function classifyFailure(error: unknown, provider: string): LlmFailure {
    if (error instanceof LlmFailure) return error
    const raw = error instanceof Error ? error.message : String(error)
    const message = `${provider}: ${raw}`.slice(0, 2000)
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return new LlmFailure('provider_unavailable', `${provider} CLI is not installed: ${raw}`, {
            retryable: false,
        })
    if (QUOTA.test(raw)) return new LlmFailure('provider_quota', message)
    if (BAD_SCHEMA.test(raw)) return new LlmFailure('bad_request', message)
    if (AUTH.test(raw))
        return new LlmFailure('provider_unavailable', message, {
            retryable: false,
        })
    if (TIMEOUT.test(raw)) return new LlmFailure('provider_timeout', message)
    // Network errors, 5xx, overload and anything unknown: worth another try.
    return new LlmFailure('provider_unavailable', message, {
        retryable: true,
    })
}

import { jsonFromText } from '../domain/coerce.js'
import { LlmFailure } from '../domain/failures.js'

type ModelUsage = {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
}
type ClaudeJson = {
    is_error?: boolean
    subtype?: string
    result?: string
    errors?: string[]
    structured_output?: unknown
    modelUsage?: Record<string, ModelUsage>
}
export type ClaudeResult = {
    output: unknown
    inputTokens: number | null
    outputTokens: number | null
    error: string | null
}

/**
 * The result object `claude -p --output-format json` prints. A failure inside
 * the run (no login, a limit) is printed there too, as `result` with
 * `is_error`; the validated object of `--json-schema` is `structured_output`.
 */
export function claudeResult(stdout: string): ClaudeResult {
    const line = stdout
        .split('\n')
        .map(item => item.trim())
        .filter(item => item.startsWith('{'))
        .at(-1)
    let data: ClaudeJson
    try {
        data = JSON.parse(line ?? '') as ClaudeJson
    } catch {
        return {
            output: undefined,
            inputTokens: null,
            outputTokens: null,
            error: stdout.trim().slice(-500) || null,
        }
    }
    // Cached prompt tokens count as input, as the other providers report them.
    const usage = Object.values(data.modelUsage ?? {})
    const inputTokens = usage.length
        ? usage.reduce(
              (sum, item) =>
                  sum
                  + (item.inputTokens ?? 0)
                  + (item.cacheReadInputTokens ?? 0)
                  + (item.cacheCreationInputTokens ?? 0),
              0,
          )
        : null
    const outputTokens = usage.length ? usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0) : null
    if (data.is_error || (data.subtype && data.subtype !== 'success')) {
        const detail = [
            data.result,
            ...(data.errors ?? []),
        ]
            .filter(Boolean)
            .join('; ')
        return {
            output: undefined,
            inputTokens,
            outputTokens,
            error:
                data.subtype === 'error_max_structured_output_retries'
                    ? `Claude gave no result matching the schema: ${detail}`
                    : detail || `Claude failed: ${data.subtype}`,
        }
    }
    return {
        output: data.structured_output ?? jsonFromText(data.result ?? ''),
        inputTokens,
        outputTokens,
        error: null,
    }
}

/** A limit pauses the provider until the reset it names ("resets 3:45pm"); a missing or expired login needs a new token. */
export function claudeFailure(error: string): Error {
    if (/hit your [\w ]*limit|usage limit|spend limit/i.test(error))
        return new LlmFailure('provider_quota', `Claude limit reached: ${error}`)
    if (/not logged in|\/login|oauth|authenticat|invalid api key|\b401\b/i.test(error))
        return new LlmFailure(
            'provider_unavailable',
            `Claude rejected the login (run claude setup-token, set CLAUDE_CODE_OAUTH_TOKEN): ${error}`,
            {
                retryable: false,
            },
        )
    return new Error(error)
}

import { coerceToSchema, jsonFromText } from '../domain/coerce.js'
import { CallAborted, LlmFailure } from '../domain/failures.js'
import { withoutMeta } from '../domain/json-schema.js'
import { correctionText, type GenerateCall, type LlmProvider, type ProviderResult } from './provider.js'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

const OVERLOAD_RETRY_MS = [
    5000,
    15_000,
    30_000,
]
const DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic'

type Block = {
    type: string
    id?: string
    name?: string
    input?: unknown
    text?: string
}
type Message = {
    role: 'user' | 'assistant'
    content: unknown
}
/** The conversation a correction round continues. */
type MinimaxTranscript = {
    messages: Message[]
    blocks: Block[]
    toolId: string | null
}

const isTranscript = (value: unknown): value is MinimaxTranscript =>
    !!value
    && typeof value === 'object'
    && Array.isArray((value as MinimaxTranscript).messages)
    && Array.isArray((value as MinimaxTranscript).blocks)

/** Seconds in a Retry-After header: a number or an HTTP date. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
    if (!header) return null
    if (/^\d+$/.test(header.trim())) return Number(header.trim())
    const date = Date.parse(header)
    return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000))
}

/** A refused HTTP call by status and body (ported from Work Finder). */
export function httpFailure(provider: string, status: number, text: string, retryAfter: number | null): LlmFailure {
    const detail = text.slice(0, 500)
    if (
        status === 429
        || /usage limit|quota|rate.?limit|insufficient (?:balance|credits)|too many requests/i.test(detail)
    )
        return new LlmFailure(
            'provider_quota',
            `${provider} limit reached${retryAfter !== null ? ` (retry after ${retryAfter} s)` : ''}: ${detail}`,
        )
    if (status === 401 || status === 403)
        return new LlmFailure('provider_unavailable', `${provider} rejected the credentials: ${detail}`, {
            retryable: false,
        })
    if (status >= 500 || status === 408)
        return new LlmFailure('provider_unavailable', `${provider} HTTP ${status}: ${detail}`, {
            retryable: true,
        })
    return new LlmFailure('bad_request', `${provider} HTTP ${status}: ${detail}`)
}

export type MinimaxOptions = {
    apiKey: string | undefined
    fetch?: Fetch
    sleep?: (ms: number) => Promise<void>
}

/**
 * MiniMax through its Anthropic-compatible Messages API. It has no strict
 * JSON mode, so the schema becomes the input of a single tool the model must
 * call. Extended thinking cannot be combined with a forced tool call, so
 * thinking profiles ask for the tool in the prompt. A correction round
 * continues the conversation: the model sees its own call with the errors.
 */
export class MinimaxProvider implements LlmProvider {
    readonly id = 'minimax' as const
    private readonly fetch: Fetch
    private readonly sleep: (ms: number) => Promise<void>

    constructor(private readonly options: MinimaxOptions) {
        this.fetch = options.fetch ?? ((input, init) => fetch(input, init))
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    }

    availability() {
        return this.options.apiKey ? null : 'MINIMAX_API_KEY is not set'
    }

    async generate(call: GenerateCall): Promise<ProviderResult> {
        const apiKey = this.options.apiKey
        if (!apiKey)
            throw new LlmFailure('provider_unavailable', 'MINIMAX_API_KEY is not set', {
                retryable: false,
            })
        const { profile, settings } = call
        const alwaysThinks = /M3\.1/i.test(profile.model)
        const thinking = profile.thinking === true || alwaysThinks
        const shape = withoutMeta(call.schema)
        const body = {
            model: profile.model,
            max_tokens: 32_000,
            system: call.system,
            tools: [
                {
                    name: 'submit_result',
                    description: 'Submit the complete result object that matches the schema.',
                    input_schema: shape,
                },
            ],
            tool_choice: thinking
                ? {
                      type: 'auto',
                  }
                : {
                      type: 'tool',
                      name: 'submit_result',
                  },
            ...(alwaysThinks
                ? {}
                : {
                      thinking: {
                          type: thinking ? 'adaptive' : 'disabled',
                      },
                  }),
            ...(alwaysThinks && profile.reasoningEffort
                ? {
                      output_config: {
                          effort: profile.reasoningEffort,
                      },
                  }
                : {}),
            ...(profile.temperature !== undefined
                ? {
                      temperature: profile.temperature,
                  }
                : {}),
        }
        const messages = this.messagesFor(call, thinking)
        const data = await this.post(
            `${(settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`,
            apiKey,
            {
                ...body,
                messages,
            },
            call,
        )
        const blocks = (Array.isArray(data.content) ? data.content : []) as Block[]
        const tool = blocks.find(block => block.type === 'tool_use' && block.name === 'submit_result')
        const raw = tool
            ? tool.input
            : jsonFromText(
                  blocks
                      .filter(block => block.type === 'text')
                      .map(block => block.text)
                      .join('\n'),
              )
        const usage = data.usage as
            | {
                  input_tokens?: number
                  output_tokens?: number
              }
            | undefined
        const transcript: MinimaxTranscript = {
            messages,
            blocks,
            toolId: tool?.id ?? null,
        }
        return {
            output: coerceToSchema(raw, shape),
            model: typeof data.model === 'string' ? data.model : profile.model,
            inputTokens: usage?.input_tokens ?? null,
            outputTokens: usage?.output_tokens ?? null,
            transcript,
        }
    }

    private messagesFor(call: GenerateCall, thinking: boolean): Message[] {
        const ask = thinking
            ? `${call.input}\n\nReturn the result by calling the submit_result tool exactly once.`
            : call.input
        const correction = call.correction
        if (!correction)
            return [
                {
                    role: 'user',
                    content: ask,
                },
            ]
        const text = `${correctionText(correction)} Call submit_result again with the complete corrected object.`
        if (isTranscript(correction.transcript)) {
            const { messages, blocks, toolId } = correction.transcript
            return [
                ...messages,
                {
                    role: 'assistant',
                    content: blocks,
                },
                {
                    role: 'user',
                    content: toolId
                        ? [
                              {
                                  type: 'tool_result',
                                  tool_use_id: toolId,
                                  is_error: true,
                                  content: text,
                              },
                          ]
                        : text,
                },
            ]
        }
        return [
            {
                role: 'user',
                content: ask,
            },
            {
                role: 'assistant',
                content: JSON.stringify(correction.output) ?? '',
            },
            {
                role: 'user',
                content: text,
            },
        ]
    }

    private async post(
        url: string,
        apiKey: string,
        body: unknown,
        call: GenerateCall,
    ): Promise<Record<string, unknown>> {
        const delays = call.settings.overloadRetryMs ?? OVERLOAD_RETRY_MS
        const deadline = Date.now() + call.timeoutMs
        for (let attempt = 0; ; attempt++) {
            if (call.signal.aborted) throw new CallAborted()
            const remaining = deadline - Date.now()
            if (remaining <= 0)
                throw new LlmFailure(
                    'provider_timeout',
                    `MiniMax did not answer in ${Math.round(call.timeoutMs / 1000)} s`,
                )
            let response: Response
            let text: string
            try {
                response = await this.fetch(url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${apiKey}`,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.any([
                        call.signal,
                        AbortSignal.timeout(remaining),
                    ]),
                })
                text = await response.text()
            } catch (error) {
                if (call.signal.aborted) throw new CallAborted()
                const name = (error as Error)?.name
                if (name === 'TimeoutError' || name === 'AbortError')
                    throw new LlmFailure(
                        'provider_timeout',
                        `MiniMax did not answer in ${Math.round(call.timeoutMs / 1000)} s`,
                    )
                throw new LlmFailure(
                    'provider_unavailable',
                    `MiniMax is unreachable: ${(error as Error)?.message ?? String(error)}`,
                    {
                        retryable: true,
                    },
                )
            }
            // An overloaded provider usually recovers within a minute; waiting here beats failing the call.
            const overloaded =
                [
                    502,
                    503,
                    529,
                ].includes(response.status) || /overloaded_error/.test(text.slice(0, 500))
            const delay = delays[attempt]
            if (overloaded && delay !== undefined && Date.now() + delay < deadline) {
                await this.sleep(delay)
                continue
            }
            if (!response.ok)
                throw httpFailure(
                    'MiniMax',
                    response.status,
                    text,
                    retryAfterSeconds(response.headers.get('retry-after')),
                )
            let data: Record<string, unknown>
            try {
                data = JSON.parse(text) as Record<string, unknown>
            } catch {
                throw new LlmFailure(
                    'provider_unavailable',
                    `MiniMax returned a non-JSON response: ${text.slice(0, 300)}`,
                    {
                        retryable: true,
                    },
                )
            }
            if (data?.type === 'error') throw httpFailure('MiniMax', 500, JSON.stringify(data.error), null)
            return data
        }
    }
}

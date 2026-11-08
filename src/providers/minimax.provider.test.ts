import { describe, expect, it } from 'vitest'
import { LlmFailure } from '../domain/failures.js'
import type { Profile } from '../domain/models.js'
import { type Fetch, MinimaxProvider, retryAfterSeconds } from './minimax.provider.js'
import type { GenerateCall } from './provider.js'

const profile: Profile = {
    id: 'minimax-m3.1-flash-low',
    label: 'MiniMax',
    provider: 'minimax',
    model: 'MiniMax-M3.1-Flash',
    reasoningEffort: 'low',
    thinking: true,
}
const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
        ids: {
            type: 'array',
            items: {
                type: 'string',
            },
        },
        n: {
            type: 'integer',
        },
    },
    required: [
        'ids',
        'n',
    ],
    additionalProperties: false,
}
const call = (overrides: Partial<GenerateCall> = {}): GenerateCall => ({
    profile,
    settings: {
        concurrency: 1,
        timeoutMs: 30_000,
        baseUrl: 'https://minimax.test/anthropic',
    },
    system: 'System text',
    input: 'Input text',
    schema,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    ...overrides,
})

type Sent = {
    url: string
    body: Record<string, unknown>
    headers: Record<string, string>
}
function scripted(responses: Array<() => Response>) {
    const sent: Sent[] = []
    const fetch: Fetch = async (url, init) => {
        sent.push({
            url,
            body: JSON.parse(String(init.body)),
            headers: init.headers as Record<string, string>,
        })
        const next = responses.shift()
        if (!next) throw new Error('no more responses')
        return next()
    }
    return {
        sent,
        fetch,
    }
}
const json =
    (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    () =>
        new Response(JSON.stringify(body), {
            status,
            headers,
        })

describe('MinimaxProvider', () => {
    it('asks for the submit_result tool and coerces its input', async () => {
        const { sent, fetch } = scripted([
            json({
                model: 'MiniMax-M3.1-Flash',
                content: [
                    {
                        type: 'thinking',
                        thinking: '...',
                    },
                    {
                        type: 'tool_use',
                        id: 'call_1',
                        name: 'submit_result',
                        input: {
                            ids: 'R1, R3',
                            n: '2',
                        },
                    },
                ],
                usage: {
                    input_tokens: 500,
                    output_tokens: 60,
                },
            }),
        ])
        const provider = new MinimaxProvider({
            apiKey: 'test-key',
            fetch,
        })
        const result = await provider.generate(call())
        expect(result.output).toEqual({
            ids: [
                'R1',
                'R3',
            ],
            n: 2,
        })
        expect([
            result.inputTokens,
            result.outputTokens,
        ]).toEqual([
            500,
            60,
        ])
        const [request] = sent
        expect(request?.url).toBe('https://minimax.test/anthropic/v1/messages')
        expect(request?.headers.authorization).toBe('Bearer test-key')
        expect(request?.body).toMatchObject({
            model: 'MiniMax-M3.1-Flash',
            system: 'System text',
            tool_choice: {
                type: 'auto',
            },
            output_config: {
                effort: 'low',
            },
            messages: [
                {
                    role: 'user',
                    content: expect.stringContaining('submit_result tool'),
                },
            ],
        })
        expect(JSON.stringify(request?.body.tools)).not.toContain('$schema')
    })

    it('continues the conversation in a correction round', async () => {
        const blocks = [
            {
                type: 'tool_use',
                id: 'call_1',
                name: 'submit_result',
                input: {
                    ids: [],
                },
            },
        ]
        const { sent, fetch } = scripted([
            json({
                content: blocks,
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                },
            }),
            json({
                content: [
                    {
                        type: 'tool_use',
                        id: 'call_2',
                        name: 'submit_result',
                        input: {
                            ids: [],
                            n: 1,
                        },
                    },
                ],
            }),
        ])
        const provider = new MinimaxProvider({
            apiKey: 'test-key',
            fetch,
        })
        const first = await provider.generate(call())
        const second = await provider.generate(
            call({
                correction: {
                    output: first.output,
                    errors: [
                        'n: required',
                    ],
                    transcript: first.transcript,
                },
            }),
        )
        expect(second.output).toEqual({
            ids: [],
            n: 1,
        })
        const messages = sent[1]?.body.messages as Array<{
            role: string
            content: unknown
        }>
        expect(messages).toHaveLength(3)
        expect(messages[1]).toEqual({
            role: 'assistant',
            content: blocks,
        })
        expect(messages[2]?.content).toEqual([
            expect.objectContaining({
                type: 'tool_result',
                tool_use_id: 'call_1',
                is_error: true,
            }),
        ])
        expect(JSON.stringify(messages[2])).toContain('n: required')
    })

    it('classifies refusals and waits out an overload', async () => {
        const waits: number[] = []
        const sleep = async (ms: number) => {
            waits.push(ms)
        }
        const quota = scripted([
            json(
                {
                    error: 'rate limit',
                },
                429,
                {
                    'retry-after': '120',
                },
            ),
        ])
        const error = await new MinimaxProvider({
            apiKey: 'k',
            fetch: quota.fetch,
        })
            .generate(call())
            .catch(e => e)
        expect(error).toBeInstanceOf(LlmFailure)
        expect(error.code).toBe('provider_quota')
        expect(error.message).toContain('retry after 120 s')

        const denied = scripted([
            json(
                {
                    error: 'bad key',
                },
                401,
            ),
        ])
        await expect(
            new MinimaxProvider({
                apiKey: 'k',
                fetch: denied.fetch,
            }).generate(call()),
        ).rejects.toMatchObject({
            code: 'provider_unavailable',
            retryable: false,
        })

        const busy = scripted([
            json(
                {
                    type: 'error',
                    error: {
                        type: 'overloaded_error',
                    },
                },
                529,
            ),
            json({
                content: [
                    {
                        type: 'text',
                        text: '```json\n{"ids":["a"],"n":3}\n```',
                    },
                ],
            }),
        ])
        const result = await new MinimaxProvider({
            apiKey: 'k',
            fetch: busy.fetch,
            sleep,
        }).generate(call())
        expect(result.output).toEqual({
            ids: [
                'a',
            ],
            n: 3,
        })
        expect(waits).toEqual([
            5000,
        ])

        await expect(
            new MinimaxProvider({
                apiKey: undefined,
            }).generate(call()),
        ).rejects.toMatchObject({
            code: 'provider_unavailable',
            retryable: false,
        })
    })

    it('reads Retry-After as seconds or an HTTP date', () => {
        expect(retryAfterSeconds('30')).toBe(30)
        expect(retryAfterSeconds('Wed, 28 Oct 2026 03:02:00 GMT', Date.parse('2026-10-28T03:00:00Z'))).toBe(120)
        expect(retryAfterSeconds(null)).toBeNull()
        expect(retryAfterSeconds('soon')).toBeNull()
    })
})

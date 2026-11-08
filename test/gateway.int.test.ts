import { sql } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmFailure } from '../src/domain/failures.js'
import { MASK } from '../src/gateway/mask.js'
import { LIMITED_KEY, startApp, type TestApp } from './harness.js'

const SCHEMA = {
    type: 'object',
    properties: {
        answer: {
            type: 'string',
        },
    },
    required: [
        'answer',
    ],
    additionalProperties: false,
}

const chat = (overrides: Record<string, unknown> = {}) => ({
    model: 'claude-haiku-5-5',
    messages: [
        {
            role: 'system',
            content: 'Be brief.',
        },
        {
            role: 'user',
            content: 'Say hi',
        },
    ],
    ...overrides,
})

const structured = (overrides: Record<string, unknown> = {}) =>
    chat({
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'answer',
                schema: SCHEMA,
            },
        },
        ...overrides,
    })

describe('llm gateway', () => {
    const apps: TestApp[] = []
    const start = async (...args: Parameters<typeof startApp>) => {
        const app = await startApp(...args)
        apps.push(app)
        return app
    }
    afterEach(async () => {
        for (const app of apps.splice(0)) await app.close()
    })

    it('refuses a missing or unknown key with the OpenAI error body', async () => {
        const t = await start()
        const missing = await t.http().post('/api/v1/chat/completions').send(chat())
        expect(missing.status).toBe(401)
        expect(missing.body.error).toMatchObject({
            code: 'invalid_api_key',
        })
        const wrong = await t
            .http()
            .post('/api/v1/chat/completions')
            .set('authorization', 'Bearer not-a-key')
            .send(chat())
        expect(wrong.status).toBe(401)
    })

    it('lists only the models a key may call', async () => {
        const t = await start()
        const all = await t.api().get('/api/v1/models')
        expect(all.status).toBe(200)
        expect(all.body.data.map((model: { id: string }) => model.id)).toEqual(
            expect.arrayContaining([
                'gpt-6-sol',
                'claude-opus-5-5',
            ]),
        )
        const limited = await t.http().get('/api/v1/models').set('authorization', `Bearer ${LIMITED_KEY}`)
        expect(limited.body.data).toEqual([
            expect.objectContaining({
                id: 'claude-haiku-5-5',
                owned_by: 'claude',
                default_effort: 'medium',
            }),
        ])
        const refused = await t
            .http()
            .post('/api/v1/chat/completions')
            .set('authorization', `Bearer ${LIMITED_KEY}`)
            .send(
                chat({
                    model: 'gpt-6-sol',
                }),
            )
        expect(refused.status).toBe(400)
        expect(refused.body.error.code).toBe('bad_request')
    })

    it('answers text through the wrapper and journals the call with secrets masked', async () => {
        const t = await start()
        t.fakes.claude.queue(call => ({
            output: {
                content: 'hi',
            },
            model: call.profile.model,
            inputTokens: 12,
            outputTokens: 3,
        }))
        const res = await t
            .api()
            .post('/api/v1/chat/completions')
            .send(
                chat({
                    reasoning_effort: 'low',
                    metadata: {
                        purpose: 'test.greeting',
                    },
                    messages: [
                        {
                            role: 'user',
                            content: 'My key is sk-proj-abcdefghijklmnopqrstuvwxyz0123',
                        },
                    ],
                }),
            )
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({
            object: 'chat.completion',
            model: 'claude-haiku-5-5',
            provider: 'claude',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: 'hi',
                    },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: 12,
                completion_tokens: 3,
                total_tokens: 15,
            },
        })
        const [call] = t.fakes.claude.calls
        expect(call?.profile).toMatchObject({
            model: 'claude-haiku-5-5',
            reasoningEffort: 'low',
        })
        expect(call?.input).toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123')

        const rows = await t.db.execute<{
            client: string
            purpose: string
            outcome: string
            request: {
                messages: {
                    content: string
                }[]
            }
        }>(sql`select client, purpose, outcome, request from llm_calls`)
        expect(rows.rows).toEqual([
            expect.objectContaining({
                client: 'tester',
                purpose: 'test.greeting',
                outcome: 'ok',
            }),
        ])
        expect(rows.rows[0]?.request.messages[0]?.content).toBe(`My key is ${MASK}`)
    })

    it('returns JSON text for a schema and corrects an answer that misses it once', async () => {
        const t = await start()
        t.fakes.claude.queue(
            call => ({
                output: {
                    wrong: true,
                },
                model: call.profile.model,
                inputTokens: 5,
                outputTokens: 1,
            }),
            call => ({
                output: {
                    answer: 'fixed',
                },
                model: call.profile.model,
                inputTokens: 6,
                outputTokens: 2,
            }),
        )
        const res = await t.api().post('/api/v1/chat/completions').send(structured())
        expect(res.status).toBe(200)
        expect(JSON.parse(res.body.choices[0].message.content)).toEqual({
            answer: 'fixed',
        })
        expect(res.body.usage.prompt_tokens).toBe(11)
        expect(t.fakes.claude.calls[1]?.correction?.errors.length).toBeGreaterThan(0)

        t.fakes.claude.queue(
            call => ({
                output: {},
                model: call.profile.model,
                inputTokens: 1,
                outputTokens: 1,
            }),
            call => ({
                output: {},
                model: call.profile.model,
                inputTokens: 1,
                outputTokens: 1,
            }),
        )
        const invalid = await t.api().post('/api/v1/chat/completions').send(structured())
        expect(invalid.status).toBe(422)
        expect(invalid.body.error.code).toBe('invalid_output')
    })

    it('refuses an effort the model does not have, json_object and streaming', async () => {
        const t = await start()
        for (const body of [
            chat({
                reasoning_effort: 'ultra',
            }),
            chat({
                response_format: {
                    type: 'json_object',
                },
            }),
            chat({
                stream: true,
            }),
        ]) {
            const res = await t.api().post('/api/v1/chat/completions').send(body)
            expect(res.status).toBe(400)
            expect(res.body.error.code).toBe('bad_request')
        }
        expect(t.fakes.claude.calls).toHaveLength(0)
    })

    it('answers 503 without a retry when the provider has no login', async () => {
        const t = await start()
        t.fakes.codex.unavailable = 'Codex is not logged in'
        const res = await t
            .api()
            .post('/api/v1/chat/completions')
            .send(
                chat({
                    model: 'gpt-6-sol',
                }),
            )
        expect(res.status).toBe(503)
        expect(res.body.error).toMatchObject({
            code: 'provider_unavailable',
            retryable: false,
        })
    })

    it('pauses a provider after a usage limit, keeps the pause over a restart, and lifts it by hand', async () => {
        const first = await start()
        first.fakes.codex.queue(() => {
            throw new Error('You have hit your usage limit. Try again in 3 hours.')
        })
        const limited = await first
            .api()
            .post('/api/v1/chat/completions')
            .send(
                chat({
                    model: 'gpt-6-sol',
                }),
            )
        expect(limited.status).toBe(429)
        expect(limited.body.error.code).toBe('provider_quota')
        expect(limited.body.error.resets_at).toEqual(expect.any(String))
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
        await first.close()
        apps.splice(apps.indexOf(first), 1)

        const second = await start(
            {},
            {
                keepData: true,
            },
        )
        const refused = await second
            .api()
            .post('/api/v1/chat/completions')
            .send(
                chat({
                    model: 'gpt-6-luna',
                }),
            )
        expect(refused.status).toBe(429)
        expect(second.fakes.codex.calls).toHaveLength(0)
        const status = await second.api().get('/api/v1/providers')
        expect(status.body.data).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'codex',
                    available: false,
                    pausedUntil: expect.any(String),
                }),
            ]),
        )
        expect((await second.api().delete('/api/v1/providers/codex/pause')).status).toBe(200)
        second.fakes.codex.queue(call => ({
            output: {
                content: 'back',
            },
            model: call.profile.model,
            inputTokens: 1,
            outputTokens: 1,
        }))
        const again = await second
            .api()
            .post('/api/v1/chat/completions')
            .send(
                chat({
                    model: 'gpt-6-luna',
                }),
            )
        expect(again.status).toBe(200)
    })

    it('returns the stored answer for a repeated Idempotency-Key without a second call', async () => {
        const t = await start()
        const send = () =>
            t.api().post('/api/v1/chat/completions').set('idempotency-key', 'cv-123:compose').send(structured())
        t.fakes.claude.queue(call => ({
            output: {
                answer: 'once',
            },
            model: call.profile.model,
            inputTokens: 1,
            outputTokens: 1,
        }))
        const one = await send()
        const two = await send()
        expect(one.status).toBe(200)
        expect(two.body).toEqual(one.body)
        expect(t.fakes.claude.calls).toHaveLength(1)
    })

    it('runs a job and shows it only to its client', async () => {
        const t = await start()
        t.fakes.claude.queue(call => ({
            output: {
                answer: 'from a job',
            },
            model: call.profile.model,
            inputTokens: 2,
            outputTokens: 2,
        }))
        const queued = await t.api().post('/api/v1/jobs').send(structured())
        expect(queued.status).toBe(202)
        expect(queued.body).toMatchObject({
            object: 'job',
            status: 'queued',
        })
        const path = `/api/v1/jobs/${queued.body.id}`
        await expect
            .poll(async () => (await t.api().get(path)).body.status, {
                timeout: 10_000,
            })
            .toBe('succeeded')
        const done = await t.api().get(path)
        expect(JSON.parse(done.body.result.choices[0].message.content)).toEqual({
            answer: 'from a job',
        })
        const other = await request(t.app.getHttpServer()).get(path).set('authorization', `Bearer ${LIMITED_KEY}`)
        expect(other.status).toBe(404)
        expect((await t.api().get('/api/v1/jobs/not-a-uuid')).status).toBe(404)
    })

    it('records a failed job with the OpenAI error', async () => {
        const t = await start()
        t.fakes.claude.queue(() => {
            throw new LlmFailure('provider_timeout', 'Claude did not finish in 900 s')
        })
        const queued = await t.api().post('/api/v1/jobs').send(chat())
        const path = `/api/v1/jobs/${queued.body.id}`
        await expect
            .poll(async () => (await t.api().get(path)).body.status, {
                timeout: 10_000,
            })
            .toBe('failed')
        expect((await t.api().get(path)).body.error).toMatchObject({
            code: 'provider_timeout',
            retryable: true,
        })
    })

    it('keeps admin routes for admin keys', async () => {
        const t = await start()
        const res = await t.http().get('/api/v1/providers').set('authorization', `Bearer ${LIMITED_KEY}`)
        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('permission_denied')
    })
})

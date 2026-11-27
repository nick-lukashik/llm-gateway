import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { llmCalls, llmUsageDaily } from '../src/db/schema.js'
import { sha256 } from '../src/gateway/clients.js'
import { nextUtcDay } from '../src/gateway/gateway.service.js'
import { MaintenanceJob } from '../src/gateway/maintenance.job.js'
import { ADMIN_KEY, LIMITED_KEY, startApp, type TestApp } from './harness.js'

const CAPPED_KEY = 'test-capped-key-0123456789'
const CLIENTS = JSON.stringify([
    {
        name: 'tester',
        keySha256: sha256(ADMIN_KEY),
        models: [
            '*',
        ],
        admin: true,
    },
    {
        name: 'limited',
        keySha256: sha256(LIMITED_KEY),
        models: [
            'claude-haiku-5-5',
        ],
    },
    {
        name: 'capped',
        keySha256: sha256(CAPPED_KEY),
        models: [
            'claude-haiku-5-5',
        ],
        dailyTokens: 10,
    },
])

const chat = (purpose: string) => ({
    model: 'claude-haiku-5-5',
    messages: [
        {
            role: 'user',
            content: 'Say hi',
        },
    ],
    metadata: {
        purpose,
    },
})

const DAY_MS = 24 * 60 * 60 * 1000
const utcDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)

/** A journal row as an earlier call left it. */
const journalRow = (createdAt: Date, tokens: number, client = 'tester') => ({
    client,
    purpose: 'seeded',
    model: 'claude-haiku-5-5',
    effort: 'low',
    provider: 'claude',
    account: 'owner',
    outcome: 'ok',
    tokensIn: tokens,
    tokensOut: 0,
    durationMs: 1000,
    queueMs: 0,
    request: {},
    createdAt,
})

describe('usage rollup and daily token limit', () => {
    let t: TestApp
    const as = (key: string) => ({
        get: (path: string) => request(t.app.getHttpServer()).get(path).set('authorization', `Bearer ${key}`),
        post: (path: string) => request(t.app.getHttpServer()).post(path).set('authorization', `Bearer ${key}`),
    })

    beforeAll(async () => {
        t = await startApp({
            LLM_CLIENTS: CLIENTS,
        })
    })
    afterAll(async () => {
        await t.close()
    })

    it('refuses calls and job submissions over the daily limit with 429 budget_exceeded until 00:00 UTC', async () => {
        // Yesterday's tokens do not count: the day starts at 00:00 UTC.
        const midnight = new Date(`${utcDay(0)}T00:00:00.000Z`)
        await t.db.insert(llmCalls).values(journalRow(new Date(midnight.getTime() - 1000), 1_000_000, 'capped'))

        const first = await as(CAPPED_KEY).post('/api/v1/chat/completions').send(chat('capped-ok'))
        expect(first.status).toBe(200)
        expect(first.body.usage.total_tokens).toBe(12)

        const call = await as(CAPPED_KEY).post('/api/v1/chat/completions').send(chat('capped-over'))
        expect(call.status).toBe(429)
        expect(call.body.error).toMatchObject({
            code: 'budget_exceeded',
            retryable: false,
            resets_at: nextUtcDay().toISOString(),
        })
        expect(Number(call.headers['retry-after'])).toBeGreaterThan(0)
        expect(Number(call.headers['retry-after'])).toBeLessThanOrEqual(24 * 60 * 60)

        const job = await as(CAPPED_KEY).post('/api/v1/jobs').send(chat('capped-job'))
        expect(job.status).toBe(429)
        expect(job.body.error.code).toBe('budget_exceeded')

        // Not a provider pause: other clients go on.
        expect((await as(LIMITED_KEY).post('/api/v1/chat/completions').send(chat('limited'))).status).toBe(200)
        const providers = await as(ADMIN_KEY).get('/api/v1/providers')
        expect(providers.body.data.every((p: { pausedUntil: string | null }) => p.pausedUntil === null)).toBe(true)

        const clients = await as(ADMIN_KEY).get('/api/v1/admin/clients')
        expect(clients.status).toBe(200)
        expect(clients.body.data).toEqual(
            expect.arrayContaining([
                {
                    name: 'capped',
                    admin: false,
                    models: [
                        'claude-haiku-5-5',
                    ],
                    dailyTokens: 10,
                    tokensToday: 12,
                },
                expect.objectContaining({
                    name: 'tester',
                    dailyTokens: null,
                }),
            ]),
        )
        expect(JSON.stringify(clients.body)).not.toContain('keySha256')
    })

    it('rolls the journal up per day idempotently and keeps days the purge removed', async () => {
        const maintenance = t.app.get(MaintenanceJob)
        // A day long gone from the journal: its rollup row stays.
        await t.db.insert(llmUsageDaily).values({
            day: utcDay(-40),
            client: 'tester',
            purpose: 'old',
            provider: 'codex',
            model: 'gpt-6-sol',
            calls: 7,
            errors: 1,
            tokensIn: 700,
            tokensOut: 70,
            durationMs: 7000,
        })
        // Yesterday, and a row older than the 14-day retention.
        await t.db.insert(llmCalls).values([
            journalRow(new Date(Date.now() - DAY_MS), 100),
            journalRow(new Date(Date.now() - 15 * DAY_MS), 5),
        ])
        t.fakes.claude.queue(() => {
            throw new Error('boom')
        })
        expect((await t.api().post('/api/v1/chat/completions').send(chat('rollup'))).status).toBeGreaterThanOrEqual(500)
        expect((await t.api().post('/api/v1/chat/completions').send(chat('rollup'))).status).toBe(200)

        await maintenance.run()
        const report = () =>
            t
                .api()
                .get('/api/v1/admin/usage')
                .query({
                    from: utcDay(-60),
                    group_by: 'day,client,purpose,provider,model',
                })
        const first = await report()
        expect(first.status).toBe(200)
        const today = first.body.data.find(
            (row: { day: string; purpose: string }) => row.day === utcDay(0) && row.purpose === 'rollup',
        )
        expect(today).toEqual({
            day: utcDay(0),
            client: 'tester',
            purpose: 'rollup',
            provider: 'claude',
            model: 'claude-haiku-5-5',
            calls: 2,
            errors: 1,
            tokensIn: 10,
            tokensOut: 2,
            seconds: expect.any(Number),
        })
        expect(first.body.data).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    day: utcDay(-1),
                    purpose: 'seeded',
                    calls: 1,
                    tokensIn: 100,
                }),
                expect.objectContaining({
                    day: utcDay(-40),
                    purpose: 'old',
                    calls: 7,
                }),
            ]),
        )
        // The row past the retention was purged, not rolled up.
        expect(first.body.data.some((row: { day: string }) => row.day === utcDay(-15))).toBe(false)

        // A repeat changes nothing; a new call is counted once.
        await maintenance.run()
        expect((await report()).body).toEqual(first.body)
        await t.api().post('/api/v1/chat/completions').send(chat('rollup'))
        await maintenance.run()
        const again = await report()
        expect(
            again.body.data.find(
                (row: { day: string; purpose: string }) => row.day === utcDay(0) && row.purpose === 'rollup',
            ),
        ).toMatchObject({
            calls: 3,
            errors: 1,
            tokensIn: 20,
        })

        const total = await t
            .api()
            .get('/api/v1/admin/usage')
            .query({
                from: utcDay(-60),
                group_by: '',
                client: 'tester',
                purpose: 'rollup',
            })
        expect(total.body.data).toEqual([
            {
                calls: 3,
                errors: 1,
                tokensIn: 20,
                tokensOut: 4,
                seconds: expect.any(Number),
            },
        ])
    })

    it('keeps the usage routes for admin keys and validates the query', async () => {
        expect((await as(LIMITED_KEY).get('/api/v1/admin/usage')).status).toBe(403)
        expect((await as(LIMITED_KEY).get('/api/v1/admin/clients')).status).toBe(403)
        expect((await request(t.app.getHttpServer()).get('/api/v1/admin/usage')).status).toBe(401)
        const bad = await t.api().get('/api/v1/admin/usage').query({
            group_by: 'day,secret',
        })
        expect(bad.status).toBe(400)
        expect(bad.body.code).toBe('VALIDATION_FAILED')
        const reversed = await t
            .api()
            .get('/api/v1/admin/usage')
            .query({
                from: utcDay(0),
                to: utcDay(-1),
            })
        expect(reversed.status).toBe(400)
        const empty = await t.api().get('/api/v1/admin/usage').query({
            client: 'nobody',
        })
        expect(empty.body).toMatchObject({
            from: utcDay(-29),
            to: utcDay(0),
            groupBy: [
                'day',
            ],
            data: [],
        })
    })

    it('documents the admin routes in OpenAPI', async () => {
        const doc = (await t.http().get('/openapi.json')).body
        expect(Object.keys(doc.paths)).toEqual(
            expect.arrayContaining([
                '/api/v1/admin/usage',
                '/api/v1/admin/clients',
            ]),
        )
        expect(Object.keys(doc.components.schemas)).toEqual(
            expect.arrayContaining([
                'UsageReport',
                'ClientsUsage',
                'LlmError',
            ]),
        )
    })
})

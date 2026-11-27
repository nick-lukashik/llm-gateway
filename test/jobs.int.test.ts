import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { PG_BOSS } from '../src/common/jobs/jobs.module.js'
import { llmJobs } from '../src/db/schema.js'
import { CALL_DEAD_QUEUE, CALL_QUEUE } from '../src/gateway/jobs.service.js'
import { blocked } from '../src/test/fake-provider.js'
import { startApp, type TestApp } from './harness.js'

/** pg-boss polls every second; a model call through the fakes is instant. */
const WAIT = {
    timeout: 15_000,
    interval: 200,
}

const request = (content = 'Say hi') => ({
    model: 'claude-haiku-5-5',
    messages: [
        {
            role: 'user',
            content,
        },
    ],
    metadata: {
        purpose: 'jobs-test',
    },
})

describe('jobs on pg-boss', () => {
    const apps: TestApp[] = []
    const start = async (...args: Parameters<typeof startApp>) => {
        const app = await startApp(...args)
        apps.push(app)
        return app
    }
    const stop = async (app: TestApp) => {
        apps.splice(apps.indexOf(app), 1)
        await app.close()
    }
    afterEach(async () => {
        for (const app of apps.splice(0)) await app.close()
    })
    // The database between two processes, when no app is running.
    const pool = new pg.Pool({
        connectionString: inject('databaseUrl'),
        max: 2,
    })
    const db = drizzle({
        client: pool,
    })
    afterAll(async () => {
        await pool.end()
    })

    const statusOf = async (t: TestApp, id: string) => (await t.api().get(`/api/v1/jobs/${id}`)).body

    it('queues the row and its pg-boss job together, with the same id', async () => {
        const t = await start()
        const queued = await t.api().post('/api/v1/jobs').send(request())
        expect(queued.status).toBe(202)
        const boss = t.app.get<PgBoss>(PG_BOSS)
        await expect.poll(async () => (await statusOf(t, queued.body.id)).status, WAIT).toBe('succeeded')
        const job = await boss.getJobById(CALL_QUEUE, queued.body.id)
        expect(job).toMatchObject({
            id: queued.body.id,
            state: 'completed',
            data: {
                jobId: queued.body.id,
            },
        })
    })

    it('finishes a job cut off by a restart: the next process retries it', async () => {
        const first = await start()
        const gate = blocked()
        first.fakes.claude.queue(gate.step)
        const queued = await first.api().post('/api/v1/jobs').send(request())
        const id = queued.body.id as string
        await expect.poll(() => first.fakes.claude.calls.length, WAIT).toBe(1)
        expect((await statusOf(first, id)).status).toBe('running')

        // A graceful stop: pg-boss fails the active job (a retry) and aborts the call.
        await stop(first)
        const [interrupted] = await db.select().from(llmJobs).where(eq(llmJobs.id, id))
        expect(interrupted).toMatchObject({
            status: 'queued',
            attempts: 1,
            finishedAt: null,
        })

        const second = await start(
            {},
            {
                keepData: true,
            },
        )
        await expect
            .poll(async () => (await statusOf(second, id)).status, {
                timeout: 20_000,
            })
            .toBe('succeeded')
        const done = await statusOf(second, id)
        expect(done.result.choices[0].message.content).toBe('ok')
        const [row] = await second.db.select().from(llmJobs).where(eq(llmJobs.id, id))
        expect(row?.attempts).toBe(2)
        expect(second.fakes.claude.calls).toHaveLength(1)
        expect(
            await second.metric('llm_gateway_jobs_total', {
                result: 'succeeded',
            }),
        ).toBe(1)
    })

    it('does not call the model again when the answer was journaled before the restart', async () => {
        const first = await start()
        const queued = await first.api().post('/api/v1/jobs').send(request())
        const id = queued.body.id as string
        await expect.poll(async () => (await statusOf(first, id)).status, WAIT).toBe('succeeded')
        await stop(first)
        // As if the process died between the journal write and the job's outcome.
        await db
            .update(llmJobs)
            .set({
                status: 'running',
                result: null,
                finishedAt: null,
            })
            .where(eq(llmJobs.id, id))

        const second = await start(
            {},
            {
                keepData: true,
            },
        )
        const boss = second.app.get<PgBoss>(PG_BOSS)
        await boss.send(
            CALL_QUEUE,
            {
                jobId: id,
            },
            {
                id: crypto.randomUUID(),
            },
        )
        await expect.poll(async () => (await statusOf(second, id)).status, WAIT).toBe('succeeded')
        expect((await statusOf(second, id)).result.object).toBe('chat.completion')
        expect(second.fakes.claude.calls).toHaveLength(0)
    })

    it('adopts unfinished jobs of the release before pg-boss at startup', async () => {
        const seed = await start()
        const rows = await seed.db
            .insert(llmJobs)
            .values([
                {
                    client: 'tester',
                    request: request('queued before'),
                    status: 'queued',
                },
                {
                    client: 'tester',
                    request: request('running before'),
                    status: 'running',
                    attempts: 1,
                },
            ])
            .returning()
        await stop(seed)

        const t = await start(
            {},
            {
                keepData: true,
            },
        )
        for (const row of rows)
            await expect.poll(async () => (await statusOf(t, row.id)).status, WAIT).toBe('succeeded')
        expect(t.fakes.claude.calls).toHaveLength(2)
    })

    it('marks a job out of attempts failed and retryable', async () => {
        const t = await start()
        const gate = blocked()
        t.fakes.claude.queue(gate.step)
        const queued = await t.api().post('/api/v1/jobs').send(request())
        const id = queued.body.id as string
        await expect.poll(() => t.fakes.claude.calls.length, WAIT).toBe(1)
        // What pg-boss does with a job past its retry limit.
        await t.app.get<PgBoss>(PG_BOSS).send(CALL_DEAD_QUEUE, {
            jobId: id,
        })
        await expect.poll(async () => (await statusOf(t, id)).status, WAIT).toBe('failed')
        expect((await statusOf(t, id)).error).toMatchObject({
            code: 'provider_unavailable',
            retryable: true,
        })
        gate.release()
        // The cut-off start keeps the first outcome.
        await expect.poll(async () => (await statusOf(t, id)).status, WAIT).toBe('failed')
    })
})

import type { ConfigType } from '@nestjs/config'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { databaseFailure, PG_POOL } from '../src/common/database/database.js'
import { dbConfig } from '../src/config/config.js'
import { startApp, type TestApp } from './harness.js'

const elapsedSince = (started: number) => performance.now() - started

describe('Postgres time budgets', () => {
    let t: TestApp
    let pool: pg.Pool
    let jobId: string
    const holder = () =>
        new pg.Client({
            connectionString: inject('databaseUrl'),
        })

    beforeAll(async () => {
        t = await startApp()
        pool = t.app.get<pg.Pool>(PG_POOL)
        const created = await t
            .api()
            .post('/api/v1/jobs')
            .send({
                model: 'claude-haiku-5-5',
                messages: [
                    {
                        role: 'user',
                        content: 'locked',
                    },
                ],
            })
        jobId = created.body.id
        // Let the runner finish it, so it does not touch the row during the lock tests.
        await vi.waitFor(
            async () => {
                const job = await t.api().get(`/api/v1/jobs/${jobId}`)
                if (job.body.status !== 'succeeded' && job.body.status !== 'failed') throw new Error('job not finished')
            },
            {
                timeout: 10_000,
                interval: 100,
            },
        )
    })
    afterAll(async () => {
        await t?.close()
    })

    it('sets the statement, lock and idle-in-transaction timeouts on every pool connection', async () => {
        const { rows } = await pool.query(
            `select current_setting('statement_timeout') as statement,
                    current_setting('lock_timeout') as lock,
                    current_setting('idle_in_transaction_session_timeout') as idle`,
        )
        expect(rows[0]).toEqual({
            statement: '5s',
            lock: '2s',
            idle: '10s',
        })
    })

    it('fails a request blocked by a lock within about 2 s with 503, then serves it again', async () => {
        const migration = holder()
        await migration.connect()
        try {
            // What a migration's ALTER TABLE holds: even plain reads wait for it.
            await migration.query('begin')
            await migration.query('lock table llm_jobs in access exclusive mode')
            const started = performance.now()
            const res = await t.api().get(`/api/v1/jobs/${jobId}`)
            const elapsed = elapsedSince(started)
            expect(res.status).toBe(503)
            expect(res.body).toEqual({
                code: 'UNAVAILABLE',
                message: 'Database lock wait timed out, retry later',
                requestId: res.headers['x-request-id'],
            })
            expect(elapsed).toBeGreaterThan(1_800)
            expect(elapsed).toBeLessThan(4_000)
        } finally {
            await migration.query('rollback')
            await migration.end()
        }
        expect(
            await t.metric('http_server_database_failures_total', {
                reason: 'lock_timeout',
            }),
        ).toBeGreaterThanOrEqual(1)
        const again = await t.api().get(`/api/v1/jobs/${jobId}`)
        expect(again.status).toBe(200)
        expect(pool.waitingCount).toBe(0)
    })

    it('gives up on a row lock held by another transaction after 2 s', async () => {
        const other = holder()
        await other.connect()
        try {
            await other.query('begin')
            await other.query('select id from llm_jobs where id = $1 for update', [
                jobId,
            ])
            const started = performance.now()
            const failure = await t.db.execute(sql`update llm_jobs set purpose = 'changed' where id = ${jobId}`).then(
                () => undefined,
                (error: unknown) => databaseFailure(error),
            )
            const elapsed = elapsedSince(started)
            expect(failure).toBe('lock_timeout')
            expect(elapsed).toBeGreaterThan(1_800)
            expect(elapsed).toBeLessThan(4_000)
        } finally {
            await other.query('rollback')
            await other.end()
        }
        // The connection went back to the pool in a usable state.
        await expect(
            t.db.execute(sql`update llm_jobs set purpose = 'changed' where id = ${jobId}`),
        ).resolves.toBeDefined()
    })

    it('answers 503 within about 2 s when no pool connection is free, then recovers', async () => {
        const { max } = t.app.get<ConfigType<typeof dbConfig>>(dbConfig.KEY)
        const held = await Promise.all(
            Array.from(
                {
                    length: max,
                },
                () => pool.connect(),
            ),
        )
        try {
            const started = performance.now()
            const res = await t.api().get(`/api/v1/jobs/${jobId}`)
            const elapsed = elapsedSince(started)
            expect(res.status).toBe(503)
            expect(res.body.message).toBe('Database is busy, retry later')
            expect(elapsed).toBeGreaterThan(1_800)
            expect(elapsed).toBeLessThan(4_000)
        } finally {
            for (const client of held) client.release()
        }
        const again = await t.api().get(`/api/v1/jobs/${jobId}`)
        expect(again.status).toBe(200)
        expect(pool.totalCount).toBeLessThanOrEqual(max)
    })

    it('ends a statement after 5 s', async () => {
        const started = performance.now()
        const failure = await t.db.execute(sql`select pg_sleep(10)`).then(
            () => undefined,
            (error: unknown) => databaseFailure(error),
        )
        expect(failure).toBe('statement_timeout')
        expect(elapsedSince(started)).toBeLessThan(7_000)
    }, 15_000)
})

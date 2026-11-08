import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { Logger } from 'nestjs-pino'
import request from 'supertest'
import { inject } from 'vitest'
import { configureApp } from '../src/app.setup.js'
import { DB } from '../src/common/database/database.js'
import { Metrics } from '../src/common/metrics/metrics.js'
import { env } from '../src/config/env.js'
import type { Db } from '../src/db/types.js'
import { sha256 } from '../src/gateway/clients.js'
import { LLM_PROVIDERS, type LlmProvider } from '../src/providers/provider.js'
import { FakeProvider } from '../src/test/fake-provider.js'

/** Keys of the test clients: an admin that may call every model, and one limited to a single model. */
export const ADMIN_KEY = 'test-admin-key-0123456789'
export const LIMITED_KEY = 'test-limited-key-0123456789'
export const TEST_CLIENTS = JSON.stringify([
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
])

/** Fake providers by default: no CLI or network in the tests. */
export const fakeProviders = () => ({
    codex: new FakeProvider('codex'),
    claude: new FakeProvider('claude'),
    minimax: new FakeProvider('minimax'),
})

export type TestApp = Awaited<ReturnType<typeof startApp>>

/**
 * The real AppModule against the shared containers, listening on a random
 * port. Every file starts from empty tables.
 */
export async function startApp(
    overrides: Record<string, string> = {},
    options: {
        providers?: LlmProvider[]
        /** Keep the journal and pauses from an earlier app (a restart). */
        keepData?: boolean
    } = {},
) {
    Object.assign(process.env, {
        NODE_ENV: 'test',
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
        APP_VERSION: 'test',
        METRICS_PORT: '0',
        DATABASE_URL: inject('databaseUrl'),
        LLM_CLIENTS: TEST_CLIENTS,
        ...overrides,
    })
    env.reset()

    const { AppModule } = await import('../src/app.module.js')
    const fakes = fakeProviders()
    const providers = options.providers ?? Object.values(fakes)
    if (!options.keepData) {
        // Before the app starts: it loads pauses and requeues jobs at startup.
        const { default: pg } = await import('pg')
        const client = new pg.Client({
            connectionString: inject('databaseUrl'),
        })
        await client.connect()
        await client.query('truncate llm_calls, llm_jobs, provider_pauses')
        await client.end()
    }
    const moduleRef = await Test.createTestingModule({
        imports: [
            AppModule,
        ],
    })
        .overrideProvider(LLM_PROVIDERS)
        .useValue(providers)
        .compile()
    const app = moduleRef.createNestApplication<NestExpressApplication>({
        bufferLogs: true,
    })
    app.useLogger(app.get(Logger))
    configureApp(app)
    await app.init()

    const db = app.get<Db>(DB)
    await app.listen(0, '127.0.0.1')
    const { registry } = app.get(Metrics)

    return {
        app,
        db,
        fakes,
        http: () => request(app.getHttpServer()),
        /** Calls to the model routes as the admin test client. */
        api: () => ({
            get: (path: string) => request(app.getHttpServer()).get(path).set('authorization', `Bearer ${ADMIN_KEY}`),
            post: (path: string) => request(app.getHttpServer()).post(path).set('authorization', `Bearer ${ADMIN_KEY}`),
            delete: (path: string) =>
                request(app.getHttpServer()).delete(path).set('authorization', `Bearer ${ADMIN_KEY}`),
        }),
        /** Sum of a metric's series that carry `labels` (0 when none). */
        metric: async (name: string, labels: Record<string, string> = {}) => {
            const metric = registry.getSingleMetric(name)
            if (!metric) throw new Error(`no metric ${name}`)
            const { values } = await metric.get()
            return values
                .filter(value => Object.entries(labels).every(([key, label]) => value.labels[key] === label))
                .reduce((sum, value) => sum + value.value, 0)
        },
        close: () => app.close(),
    }
}

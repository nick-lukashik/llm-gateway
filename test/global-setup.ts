import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'
import { migrateDatabase } from '../src/db/migrations.js'
import { IMAGES } from './containers.js'

declare module 'vitest' {
    // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation merges only with an interface
    export interface ProvidedContext {
        databaseUrl: string
    }
}

/**
 * Postgres once per run: TEST_DATABASE_URL when set (the org build workflow
 * exports it for its service container), else a Testcontainers one. Plain
 * DATABASE_URL is never used: the tests truncate tables, so a shell that
 * happens to export it cannot hit a real database. Migrations run first.
 */
export default async function setup(project: TestProject) {
    let databaseUrl = process.env.TEST_DATABASE_URL
    let teardown = async () => {}

    if (!databaseUrl) {
        const postgres = await new PostgreSqlContainer(IMAGES.postgres).start()
        databaseUrl = postgres.getConnectionUri()
        teardown = async () => {
            await postgres.stop()
        }
    }

    await migrateDatabase(databaseUrl)
    project.provide('databaseUrl', databaseUrl)
    return teardown
}

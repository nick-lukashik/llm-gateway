import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, gte, lte, type SQL, sql } from 'drizzle-orm'
import { DB } from '../common/database/database.js'
import { llmCalls, llmUsageDaily } from '../db/schema.js'
import type { Db } from '../db/types.js'

/** What llm_usage_daily is keyed by; a report groups by any of them. */
export const usageDimensions = [
    'day',
    'client',
    'purpose',
    'provider',
    'model',
] as const
export type UsageDimension = (typeof usageDimensions)[number]

export type UsageFilter = {
    from: string
    to: string
    client?: string | undefined
    purpose?: string | undefined
    provider?: string | undefined
    model?: string | undefined
}

export type UsageGroup = Partial<Record<UsageDimension, string | null>> & {
    calls: number
    errors: number
    tokensIn: number
    tokensOut: number
    durationMs: number
}

/** 00:00 UTC of today, minus `days` days, as a timestamptz. */
const utcMidnight = (days: number) =>
    sql`(((now() at time zone 'UTC')::date - ${days}::int)::timestamp at time zone 'UTC')`

/** SQL of the daily usage rollup (D-177) and of the per-client daily token limit. */
@Injectable()
export class UsageRepository {
    constructor(@Inject(DB) private readonly db: Db) {}

    /**
     * Recomputes the rollup of the last `days` UTC days (today included) from
     * the journal and upserts it: the same journal gives the same rows, so a
     * repeat, a retry or two runs at once change nothing. Only days the
     * journal still holds in full are touched: with a retention of N days the
     * purge deletes rows older than N×24 h, so the last N UTC days are whole.
     * Returns the rows written.
     */
    async rollup(days: number): Promise<number> {
        const c = llmCalls
        const result = await this.db.execute(sql`
            insert into ${llmUsageDaily} as u (day, client, purpose, provider, model, calls, errors, tokens_in, tokens_out, duration_ms, updated_at)
            select (${c.createdAt} at time zone 'UTC')::date, ${c.client}, ${c.purpose}, ${c.provider}, ${c.model},
                count(*), count(*) filter (where ${c.outcome} <> 'ok'),
                coalesce(sum(${c.tokensIn}), 0), coalesce(sum(${c.tokensOut}), 0), coalesce(sum(${c.durationMs}), 0), now()
            from ${c}
            where ${c.createdAt} >= ${utcMidnight(days - 1)}
            group by 1, 2, 3, 4, 5
            on conflict on constraint llm_usage_daily_key do update set
                calls = excluded.calls,
                errors = excluded.errors,
                tokens_in = excluded.tokens_in,
                tokens_out = excluded.tokens_out,
                duration_ms = excluded.duration_ms,
                updated_at = excluded.updated_at
            where (u.calls, u.errors, u.tokens_in, u.tokens_out, u.duration_ms)
                is distinct from (excluded.calls, excluded.errors, excluded.tokens_in, excluded.tokens_out, excluded.duration_ms)
        `)
        return result.rowCount ?? 0
    }

    /** Input plus output tokens of a client's calls since 00:00 UTC, every outcome; read from the journal, so it is current. */
    async tokensToday(client: string): Promise<number> {
        const [row] = await this.db
            .select({
                tokens: sql<string>`coalesce(sum(coalesce(${llmCalls.tokensIn}, 0) + coalesce(${llmCalls.tokensOut}, 0)), 0)`,
            })
            .from(llmCalls)
            .where(and(eq(llmCalls.client, client), gte(llmCalls.createdAt, utcMidnight(0))))
        return Number(row?.tokens ?? 0)
    }

    /** Tokens of every client since 00:00 UTC. */
    async tokensTodayByClient(): Promise<Map<string, number>> {
        const rows = await this.db
            .select({
                client: llmCalls.client,
                tokens: sql<string>`sum(coalesce(${llmCalls.tokensIn}, 0) + coalesce(${llmCalls.tokensOut}, 0))`,
            })
            .from(llmCalls)
            .where(gte(llmCalls.createdAt, utcMidnight(0)))
            .groupBy(llmCalls.client)
        return new Map(
            rows.map(row => [
                row.client,
                Number(row.tokens),
            ]),
        )
    }

    /** Sums over a UTC day range, filtered, grouped by `groupBy` (none: one total row, absent without calls). */
    async query(filter: UsageFilter, groupBy: UsageDimension[]): Promise<UsageGroup[]> {
        const u = llmUsageDaily
        const columns: Record<UsageDimension, SQL<string | null>> = {
            day: sql<string>`${u.day}::text`,
            client: sql<string>`${u.client}`,
            purpose: sql<string | null>`${u.purpose}`,
            provider: sql<string>`${u.provider}`,
            model: sql<string>`${u.model}`,
        }
        const conditions: SQL[] = [
            gte(u.day, filter.from),
            lte(u.day, filter.to),
        ]
        for (const name of [
            'client',
            'purpose',
            'provider',
            'model',
        ] as const) {
            const value = filter[name]
            if (value !== undefined) conditions.push(eq(u[name], value))
        }
        const dims = groupBy.map(name => columns[name])
        const rows = await this.db
            .select({
                ...Object.fromEntries(
                    groupBy.map(name => [
                        name,
                        columns[name],
                    ]),
                ),
                calls: sql<string>`sum(${u.calls})`,
                errors: sql<string>`sum(${u.errors})`,
                tokensIn: sql<string>`sum(${u.tokensIn})`,
                tokensOut: sql<string>`sum(${u.tokensOut})`,
                durationMs: sql<string>`sum(${u.durationMs})`,
            })
            .from(u)
            .where(and(...conditions))
            .groupBy(...dims)
            .having(sql`count(*) > 0`)
            .orderBy(...dims.map(dim => asc(dim)))
        return rows.map(row => {
            const record = row as Record<string, unknown>
            return {
                ...Object.fromEntries(
                    groupBy.map(name => [
                        name,
                        (record[name] as string | null) ?? null,
                    ]),
                ),
                calls: Number(row.calls),
                errors: Number(row.errors),
                tokensIn: Number(row.tokensIn),
                tokensOut: Number(row.tokensOut),
                durationMs: Number(row.durationMs),
            }
        })
    }
}

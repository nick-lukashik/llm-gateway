import { describe, expect, it } from 'vitest'
import { clientSchema } from '../config/env.js'
import { MAX_USAGE_DAYS, usageQuerySchema } from './admin.schemas.js'
import { nextUtcDay } from './gateway.service.js'

describe('daily token limit', () => {
    it('starts the next day at 00:00 UTC', () => {
        expect(nextUtcDay(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
        expect(nextUtcDay(new Date('2026-11-27T00:00:00.000Z')).toISOString()).toBe('2026-11-28T00:00:00.000Z')
        // 01:00 in Tbilisi is still the day before in UTC.
        expect(nextUtcDay(new Date('2026-11-27T21:00:00.000+04:00')).toISOString()).toBe('2026-11-28T00:00:00.000Z')
    })

    it('is optional in an LLM_CLIENTS entry and a positive whole number', () => {
        const entry = {
            name: 'tailor-stand',
            keySha256: 'a'.repeat(64),
            models: [
                'claude-haiku-5-5',
            ],
        }
        expect(clientSchema.parse(entry).dailyTokens).toBeUndefined()
        expect(
            clientSchema.parse({
                ...entry,
                dailyTokens: 200_000,
            }).dailyTokens,
        ).toBe(200_000)
        for (const dailyTokens of [
            0,
            -1,
            1.5,
            '100',
        ])
            expect(
                clientSchema.safeParse({
                    ...entry,
                    dailyTokens,
                }).success,
            ).toBe(false)
    })
})

describe('usage query', () => {
    it('defaults to the last 30 UTC days grouped by day', () => {
        const query = usageQuerySchema.parse({
            to: '2026-11-27',
        })
        expect(query).toMatchObject({
            from: '2026-10-29',
            to: '2026-11-27',
            group_by: [
                'day',
            ],
        })
    })

    it('takes a comma-separated grouping, without repeats; empty means one total', () => {
        expect(
            usageQuerySchema.parse({
                group_by: 'client, model,client',
            }).group_by,
        ).toEqual([
            'client',
            'model',
        ])
        expect(
            usageQuerySchema.parse({
                group_by: '',
            }).group_by,
        ).toEqual([])
    })

    it('refuses unknown groups, unknown fields, reversed and too long ranges', () => {
        for (const input of [
            {
                group_by: 'day,request',
            },
            {
                outcome: 'ok',
            },
            {
                from: '2026-11-28',
                to: '2026-11-27',
            },
            {
                from: '2020-01-01',
                to: '2026-11-27',
            },
        ])
            expect(usageQuerySchema.safeParse(input).success).toBe(false)
        expect(MAX_USAGE_DAYS).toBe(366)
    })
})

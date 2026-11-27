import { z } from 'zod'
import { llmErrorCodes } from '../domain/failures.js'
import { usageDimensions } from './usage.repository.js'

/** The longest range one usage query covers. */
export const MAX_USAGE_DAYS = 366

const DAY_MS = 24 * 60 * 60 * 1000
const today = () => new Date().toISOString().slice(0, 10)
const daysBefore = (day: string, days: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)

const dimension = z.enum(usageDimensions)
const filter = z.string().min(1).max(200).optional()

/** `GET /api/v1/admin/usage`: a UTC day range (default: the last 30 days), filters and the grouping. */
export const usageQuerySchema = z
    .strictObject({
        from: z.iso.date().optional().meta({
            description: 'First UTC day, included; default: 29 days before `to`',
        }),
        to: z.iso.date().optional().meta({
            description: 'Last UTC day, included; default: today',
        }),
        group_by: z
            .string()
            .max(200)
            .default('day')
            .meta({
                description: `Comma-separated, any of: ${usageDimensions.join(', ')}. Empty: one total row`,
            })
            .transform((value, ctx) => {
                const names = value
                    .split(',')
                    .map(name => name.trim())
                    .filter(Boolean)
                const parsed = z.array(dimension).safeParse(names)
                if (!parsed.success) {
                    ctx.addIssue({
                        code: 'custom',
                        message: `group_by takes ${usageDimensions.join(', ')}`,
                    })
                    return z.NEVER
                }
                return [
                    ...new Set(parsed.data),
                ]
            }),
        client: filter,
        purpose: filter,
        provider: filter,
        model: filter,
    })
    .transform((query, ctx) => {
        const to = query.to ?? today()
        const from = query.from ?? daysBefore(to, 29)
        if (from > to) {
            ctx.addIssue({
                code: 'custom',
                path: [
                    'from',
                ],
                message: 'from is after to',
            })
            return z.NEVER
        }
        if (Date.parse(to) - Date.parse(from) >= MAX_USAGE_DAYS * DAY_MS) {
            ctx.addIssue({
                code: 'custom',
                path: [
                    'from',
                ],
                message: `A range covers at most ${MAX_USAGE_DAYS} days`,
            })
            return z.NEVER
        }
        return {
            ...query,
            from,
            to,
        }
    })
export type UsageQuery = z.output<typeof usageQuerySchema>

const usageRowSchema = z.object({
    day: z.iso.date().optional().meta({
        description: 'With group_by day',
    }),
    client: z.string().optional(),
    purpose: z.string().nullable().optional().meta({
        description: '`metadata.purpose` of the calls; null for calls without one',
    }),
    provider: z.string().optional(),
    model: z.string().optional(),
    calls: z.number().int(),
    errors: z.number().int().meta({
        description: 'Calls whose outcome is not ok: errors, refusals and calls the caller left',
    }),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    seconds: z.number().meta({
        description: 'Total time of the calls, slot waits included',
    }),
})

export const usageResponseSchema = z
    .object({
        from: z.iso.date(),
        to: z.iso.date(),
        groupBy: z.array(dimension),
        data: z.array(usageRowSchema),
    })
    .meta({
        id: 'UsageReport',
        description:
            'Sums of the daily rollup (UTC days). Recomputed from the journal every 10 minutes, so today lags by up to that much',
    })
export type UsageResponse = z.output<typeof usageResponseSchema>

const clientUsageSchema = z.object({
    name: z.string(),
    admin: z.boolean(),
    models: z.array(z.string()),
    dailyTokens: z.number().int().nullable().meta({
        description: 'Input plus output tokens per UTC day; null: unlimited',
    }),
    tokensToday: z.number().int().meta({
        description: 'Input plus output tokens since 00:00 UTC, read from the journal (current)',
    }),
})

export const clientsResponseSchema = z
    .object({
        data: z.array(clientUsageSchema),
    })
    .meta({
        id: 'ClientsUsage',
    })
export type ClientsResponse = z.output<typeof clientsResponseSchema>

/** The OpenAI-shaped error of the model and admin routes (401, 403, 429 and the gateway's codes). */
export const llmErrorSchema = z
    .object({
        error: z.object({
            message: z.string(),
            type: z.string(),
            code: z.enum([
                ...llmErrorCodes,
                'invalid_api_key',
                'permission_denied',
            ]),
            param: z.null(),
            retryable: z.boolean().optional(),
            resets_at: z.iso.datetime().nullable().optional(),
        }),
    })
    .meta({
        id: 'LlmError',
    })

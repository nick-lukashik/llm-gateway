import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const providerIds = [
    'codex',
    'claude',
] as const
export const providerIdSchema = z.enum(providerIds)
export type ProviderId = z.infer<typeof providerIdSchema>

/** Reasoning efforts the CLIs accept; a model lists the ones it supports. */
export const efforts = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
] as const
export const effortSchema = z.enum(efforts)
export type Effort = z.infer<typeof effortSchema>

const providerSettingsSchema = z.strictObject({
    /** Calls at once per provider account; the next ones wait in a FIFO queue. */
    concurrency: z.number().int().min(1).max(20),
    /** One call when the request names no timeout. */
    timeoutMs: z.number().int().min(10_000).max(3_600_000),
    /** HTTP providers only. */
    baseUrl: z.url().optional(),
    /** Waits before repeating a call refused as overloaded (502/503/529). */
    overloadRetryMs: z.array(z.number().int().min(0).max(120_000)).optional(),
})
export type ProviderSettings = z.infer<typeof providerSettingsSchema>

const modelSchema = z.strictObject({
    /** What clients send as `model`. */
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
    label: z.string().min(1).max(120),
    provider: providerIdSchema,
    /** The provider's own model name. */
    model: z.string().min(1).max(100),
    efforts: z.array(effortSchema).min(1),
    defaultEffort: effortSchema,
})
export type CatalogModel = z.infer<typeof modelSchema>

/** The models file: no secrets, keys come from the environment. */
export const catalogSchema = z
    .strictObject({
        providers: z.partialRecord(providerIdSchema, providerSettingsSchema),
        models: z.array(modelSchema).min(1),
    })
    .superRefine((file, ctx) => {
        const seen = new Set<string>()
        file.models.forEach((model, index) => {
            if (seen.has(model.id))
                ctx.addIssue({
                    code: 'custom',
                    path: [
                        'models',
                        index,
                        'id',
                    ],
                    message: `Duplicate model ${model.id}`,
                })
            seen.add(model.id)
            if (!file.providers[model.provider])
                ctx.addIssue({
                    code: 'custom',
                    path: [
                        'models',
                        index,
                        'provider',
                    ],
                    message: `No settings for provider ${model.provider}`,
                })
            if (!model.efforts.includes(model.defaultEffort))
                ctx.addIssue({
                    code: 'custom',
                    path: [
                        'models',
                        index,
                        'defaultEffort',
                    ],
                    message: `Default effort ${model.defaultEffort} is not among the model's efforts`,
                })
        })
    })
export type Catalog = z.infer<typeof catalogSchema>

export function parseCatalog(input: unknown): Catalog {
    return catalogSchema.parse(input)
}

export function loadCatalog(path: string): Catalog {
    return parseCatalog(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * What a provider runs: one model at one effort. `id` is `<model>@<effort>`,
 * the metrics label (bounded: it comes from the catalog, not the request).
 */
export type Profile = {
    id: string
    label: string
    provider: ProviderId
    model: string
    reasoningEffort: Effort
}

export function profileOf(model: CatalogModel, effort: Effort): Profile {
    return {
        id: `${model.id}@${effort}`,
        label: `${model.label} · ${effort}`,
        provider: model.provider,
        model: model.model,
        reasoningEffort: effort,
    }
}

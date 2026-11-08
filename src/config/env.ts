import { z } from 'zod'
import { baseEnvSchema, defineEnv, metricsEnvSchema, postgresEnvSchema } from '../common/config/define-env.js'

/** A command line: the program and its leading arguments, split on spaces (`node fake-codex.mjs` in tests). */
const command = (fallback: string) =>
    z
        .string()
        .min(1)
        .default(fallback)
        .transform(value => value.trim().split(/\s+/))

/** Optional text; an empty value (`KEY=` in .env) counts as unset. */
const optionalText = z.preprocess(value => (value === '' ? undefined : value), z.string().min(1).optional())

/** One client of the gateway: the SHA-256 of its key (not secret), the models it may call, admin routes. */
export const clientSchema = z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    keySha256: z.string().regex(/^[0-9a-f]{64}$/),
    models: z.array(z.string().min(1)).min(1),
    admin: z.boolean().default(false),
})
export type ClientEntry = z.output<typeof clientSchema>

const clients = z
    .string()
    .default('[]')
    .transform((value, ctx) => {
        try {
            return JSON.parse(value) as unknown
        } catch {
            ctx.addIssue({
                code: 'custom',
                message: 'LLM_CLIENTS is not JSON',
            })
            return z.NEVER
        }
    })
    .pipe(z.array(clientSchema))

const gatewayEnvSchema = z.object({
    /** The model catalog; empty: config/models.json of this app. */
    LLM_MODELS_PATH: optionalText,
    /** Clients and their key hashes, JSON (scripts/client-key.mjs prints a line). */
    LLM_CLIENTS: clients,
    /** The one logged-in account per provider. */
    LLM_ACCOUNT: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .default('owner'),
    CODEX_COMMAND: command('codex'),
    /** Codex login and state (codex login --device-auth with this CODEX_HOME). Empty: ~/.codex. */
    CODEX_HOME: optionalText,
    CLAUDE_COMMAND: command('claude'),
    /** Claude Code subscription token (claude setup-token). Unset: Claude models unavailable. */
    CLAUDE_CODE_OAUTH_TOKEN: optionalText,
    /** MiniMax API key. Unset: MiniMax models unavailable. */
    MINIMAX_API_KEY: optionalText,
    /** Pause after a usage limit whose reset time the provider did not name. */
    LLM_QUOTA_PAUSE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
    /** Longest wait for a free provider slot before 503 provider_unavailable. */
    LLM_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(900_000),
    /** Calls and finished jobs older than this are deleted, texts included (D-107). */
    LLM_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    /** Jobs running at once; each still waits for its provider slot. */
    LLM_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
})

/** Every variable this service reads. Nothing else touches process.env. */
export const envSchema = baseEnvSchema
    .extend(postgresEnvSchema.shape)
    .extend(metricsEnvSchema.shape)
    .extend(gatewayEnvSchema.shape)

export type Env = z.output<typeof envSchema>

export const env = defineEnv(envSchema)

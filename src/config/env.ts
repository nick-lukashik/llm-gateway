import type { z } from 'zod'
import { baseEnvSchema, defineEnv, metricsEnvSchema, postgresEnvSchema } from '../common/config/define-env.js'

/** Every variable this service reads. Nothing else touches process.env. */
export const envSchema = baseEnvSchema.extend(postgresEnvSchema.shape).extend(metricsEnvSchema.shape)

export type Env = z.output<typeof envSchema>

export const env = defineEnv(envSchema)

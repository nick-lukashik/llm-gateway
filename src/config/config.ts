import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerAs } from '@nestjs/config'
import { env } from './env.js'

/** Service name: logs, metrics, connection names. Rename it with the repo. */
export const SERVICE_NAME = 'llm-gateway'

export const appConfig = registerAs('app', () => ({
    service: SERVICE_NAME,
    nodeEnv: env().NODE_ENV,
    production: env().NODE_ENV === 'production',
    port: env().PORT,
    version: env().APP_VERSION,
    logLevel: env().LOG_LEVEL,
    trustProxyHops: env().TRUST_PROXY_HOPS,
    shutdownDelayMs: env().SHUTDOWN_DELAY_MS,
    metricsPort: env().METRICS_PORT,
}))

export const dbConfig = registerAs('db', () => ({
    url: env().DATABASE_URL,
    max: env().DATABASE_POOL_MAX,
}))

export const gatewayConfig = registerAs('gateway', () => ({
    modelsPath: env().LLM_MODELS_PATH,
    clients: env().LLM_CLIENTS,
    account: env().LLM_ACCOUNT,
    codexCommand: env().CODEX_COMMAND,
    /** Codex login and state; ~/.codex when unset. */
    codexHome: env().CODEX_HOME ?? join(homedir(), '.codex'),
    claudeCommand: env().CLAUDE_COMMAND,
    claudeToken: env().CLAUDE_CODE_OAUTH_TOKEN,
    quotaPauseSeconds: env().LLM_QUOTA_PAUSE_SECONDS,
    queueTimeoutMs: env().LLM_QUEUE_TIMEOUT_MS,
    retentionDays: env().LLM_LOG_RETENTION_DAYS,
    jobConcurrency: env().LLM_JOB_CONCURRENCY,
}))
export type GatewayConfig = ReturnType<typeof gatewayConfig>

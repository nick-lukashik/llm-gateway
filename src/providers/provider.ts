import type { SchemaObject } from '../domain/json-schema.js'
import type { Profile, ProviderId, ProviderSettings } from '../domain/models.js'

/** A second round after an answer that failed the schema. */
export type Correction = {
    output: unknown
    errors: string[]
    /** What the provider returned with the first answer (its conversation). */
    transcript?: unknown
}

export type GenerateCall = {
    profile: Profile
    settings: ProviderSettings
    system: string
    input: string
    /** The request's JSON Schema, as the caller sent it. */
    schema: SchemaObject
    timeoutMs: number
    /** Aborted when the caller leaves: the provider stops its run. */
    signal: AbortSignal
    correction?: Correction
}

export type ProviderResult = {
    output: unknown
    model: string
    inputTokens: number | null
    outputTokens: number | null
    /** Provider state a correction round continues from (an HTTP provider's messages). */
    transcript?: unknown
}

export type LlmProvider = {
    readonly id: ProviderId
    /** null when the provider can be called, else why not (no login, no key). */
    availability(): string | null
    generate(call: GenerateCall): Promise<ProviderResult>
}

/** The providers the gateway serves; tests swap in fakes. */
export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS')

const MAX_PREVIOUS_CHARS = 200_000

/** The correction a model gets with its own answer and the schema errors. */
export function correctionText(correction: Correction): string {
    return [
        'The result does not match the required JSON Schema:',
        ...correction.errors.map(error => `- ${error}`),
        'Return the complete corrected result.',
    ].join('\n')
}

/** The stdin prompt of the CLI providers: system, input and, in a second round, the correction. */
export function cliPrompt(call: GenerateCall): string {
    const parts = [
        call.system,
        call.input,
    ]
    if (call.correction) {
        const previous = JSON.stringify(call.correction.output) ?? 'undefined'
        parts.push(`Your previous result:\n${previous.slice(0, MAX_PREVIOUS_CHARS)}`, correctionText(call.correction))
    }
    return parts.join('\n\n')
}

/**
 * Variables a CLI child gets: what it needs to run and reach its provider,
 * never the gateway token or the other providers' keys (a model in a
 * sandbox can still read its environment).
 */
const CHILD_ENV = [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    // Windows (tests on a developer machine).
    'SystemRoot',
    'windir',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
]

export function childEnv(
    extra: Record<string, string | undefined>,
    source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const key of CHILD_ENV) if (source[key] !== undefined) env[key] = source[key]
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value
    return env
}

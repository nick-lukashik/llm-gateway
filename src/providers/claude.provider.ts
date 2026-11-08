import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmFailure } from '../domain/failures.js'
import { toDraft7 } from '../domain/json-schema.js'
import { claudeFailure, claudeResult } from './claude-result.js'
import { childEnv, cliPrompt, type GenerateCall, type LlmProvider, type ProviderResult } from './provider.js'
import { runCli } from './run-cli.js'

/** Variables that would send `claude` to an API key or a cloud provider instead of the subscription token. */
export const claudeOverrides = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
]

const SYSTEM_PROMPT =
    'You produce one structured result for an automated pipeline. Follow the instructions in the message exactly and return the result as the structured output.'

export type ClaudeOptions = {
    command: readonly string[]
    oauthToken: string | undefined
    tmpRoot?: string
}

/** The `claude -p` arguments of one call; the prompt goes on stdin. */
export function claudeArgs(schema: Record<string, unknown>, model: string, effort: string | undefined): string[] {
    return [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(toDraft7(schema)),
        '--model',
        model,
        ...(effort
            ? [
                  '--effort',
                  effort,
              ]
            : []),
        '--tools',
        '',
        '--strict-mcp-config',
        '--safe-mode',
        '--no-session-persistence',
        '--max-turns',
        '4',
        '--system-prompt',
        SYSTEM_PROMPT,
    ]
}

/**
 * Claude Code under the subscription token (CLAUDE_CODE_OAUTH_TOKEN): no
 * tools, no CLAUDE.md, hooks or MCP, no saved session; the CLI validates the
 * answer against --json-schema and prints it as `structured_output`.
 */
export class ClaudeProvider implements LlmProvider {
    readonly id = 'claude' as const

    constructor(private readonly options: ClaudeOptions) {}

    availability() {
        return this.options.oauthToken ? null : 'CLAUDE_CODE_OAUTH_TOKEN is not set (claude setup-token)'
    }

    async generate(call: GenerateCall): Promise<ProviderResult> {
        if (!this.options.oauthToken)
            throw new LlmFailure('provider_unavailable', this.availability() ?? '', {
                retryable: false,
            })
        const dir = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), 'llm-gateway-claude-'))
        try {
            // The allowlist already leaves out claudeOverrides; the token is the only credential.
            const env = childEnv({
                CLAUDE_CODE_OAUTH_TOKEN: this.options.oauthToken,
                DISABLE_UPDATES: '1',
                DISABLE_AUTOUPDATER: '1',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                USE_BUILTIN_RIPGREP: process.env.USE_BUILTIN_RIPGREP,
                CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
            })
            for (const key of claudeOverrides) delete env[key]
            const run = await runCli(this.options.command, {
                name: 'Claude',
                args: claudeArgs(call.schema, call.profile.model, call.profile.reasoningEffort),
                stdin: cliPrompt(call),
                cwd: dir,
                env,
                timeoutMs: call.timeoutMs,
                signal: call.signal,
            })
            const parsed = claudeResult(run.stdout)
            if (parsed.error || run.code !== 0)
                throw claudeFailure(parsed.error ?? (run.stderr.trim().slice(-500) || `Claude exited ${run.code}`))
            return {
                output: parsed.output,
                model: call.profile.model,
                inputTokens: parsed.inputTokens,
                outputTokens: parsed.outputTokens,
            }
        } finally {
            await rm(dir, {
                recursive: true,
                force: true,
            })
        }
    }
}

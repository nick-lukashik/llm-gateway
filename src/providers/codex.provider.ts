import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonFromText } from '../domain/coerce.js'
import { normalizeSchemaForCodex, restoreFromCodex, withoutMeta } from '../domain/json-schema.js'
import { codexEvents } from './codex-events.js'
import { childEnv, cliPrompt, type GenerateCall, type LlmProvider, type ProviderResult } from './provider.js'
import { lastErrorLine, runCli } from './run-cli.js'

export type CodexOptions = {
    /** The CLI and any leading arguments; `["codex"]` in the image. */
    command: readonly string[]
    codexHome: string
    /** Where the per-call folders go (default: the OS temp folder). */
    tmpRoot?: string
}

/** The `codex exec` arguments of one call; the prompt goes on stdin (`-`). */
export function codexArgs(
    model: string,
    effort: string,
    dir: string,
    schemaPath: string,
    outputPath: string,
): string[] {
    return [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--model',
        model,
        '--config',
        `model_reasoning_effort="${effort}"`,
        '-C',
        dir,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '-',
    ]
}

/**
 * Codex CLI under the ChatGPT login in CODEX_HOME: one ephemeral run per
 * call in its own temp folder (removed afterwards), read-only sandbox, the
 * answer constrained by --output-schema and read from --output-last-message;
 * token usage from the `turn.completed` event.
 */
export class CodexProvider implements LlmProvider {
    readonly id = 'codex' as const

    constructor(private readonly options: CodexOptions) {}

    availability() {
        return existsSync(join(this.options.codexHome, 'auth.json'))
            ? null
            : `Codex is not logged in: run codex login --device-auth with CODEX_HOME=${this.options.codexHome}`
    }

    async generate(call: GenerateCall): Promise<ProviderResult> {
        const dir = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), 'llm-gateway-codex-'))
        try {
            const schemaPath = join(dir, 'schema.json')
            const outputPath = join(dir, 'output.json')
            const { schema, wrapped } = normalizeSchemaForCodex(withoutMeta(call.schema))
            await writeFile(schemaPath, JSON.stringify(schema))
            const run = await runCli(this.options.command, {
                name: 'Codex',
                args: codexArgs(
                    call.profile.model,
                    call.profile.reasoningEffort ?? 'medium',
                    dir,
                    schemaPath,
                    outputPath,
                ),
                stdin: cliPrompt(call),
                cwd: dir,
                env: childEnv({
                    CODEX_HOME: this.options.codexHome,
                }),
                timeoutMs: call.timeoutMs,
                signal: call.signal,
                maxStdout: 200_000,
            })
            const events = codexEvents(run.stdout)
            if (run.code !== 0) throw new Error(events.error ?? lastErrorLine(run.stderr) ?? `Codex exited ${run.code}`)
            let text: string
            try {
                text = await readFile(outputPath, 'utf8')
            } catch {
                throw new Error(events.error ?? 'Codex finished without a result')
            }
            let parsed: unknown
            try {
                parsed = JSON.parse(text)
            } catch {
                parsed = jsonFromText(text)
            }
            return {
                output: restoreFromCodex(parsed, call.schema, wrapped),
                model: call.profile.model,
                inputTokens: events.usage?.input_tokens ?? null,
                outputTokens: events.usage?.output_tokens ?? null,
            }
        } finally {
            await rm(dir, {
                recursive: true,
                force: true,
            })
        }
    }
}

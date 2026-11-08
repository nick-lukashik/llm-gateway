import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmFailure } from '../domain/failures.js'
import type { Profile } from '../domain/models.js'
import { CodexProvider } from './codex.provider.js'
import { codexEvents } from './codex-events.js'
import type { GenerateCall } from './provider.js'

const script = fileURLToPath(new URL('../test/fake-codex.mjs', import.meta.url))
const profile: Profile = {
    id: 'codex-sol-low',
    label: 'Codex',
    provider: 'codex',
    model: 'gpt-6-sol',
    reasoningEffort: 'low',
}
const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
        ok: {
            type: 'boolean',
        },
        note: {
            type: 'string',
            maxLength: 10,
        },
    },
    required: [
        'ok',
    ],
    additionalProperties: false,
}

describe('codexEvents', () => {
    it('takes usage from the completed turn and the error of a failed one', () => {
        const done = [
            '{"type":"thread.started","thread_id":"t"}',
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{}"}}',
            '{"type":"turn.completed","usage":{"input_tokens":13688,"cached_input_tokens":11776,"output_tokens":512,"reasoning_output_tokens":300}}',
        ].join('\n')
        expect(codexEvents(done)).toEqual({
            usage: {
                input_tokens: 13688,
                cached_input_tokens: 11776,
                output_tokens: 512,
                reasoning_output_tokens: 300,
            },
            error: null,
        })
        const failed = [
            '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata not found"}}',
            '{"type":"error","message":"stream error"}',
            '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again at 5:03 AM."}}',
            'not json',
            '{broken',
        ].join('\r\n')
        expect(codexEvents(failed)).toEqual({
            usage: null,
            error: "You've hit your usage limit. Try again at 5:03 AM.",
        })
        expect(codexEvents('')).toEqual({
            usage: null,
            error: null,
        })
    })
})

describe('CodexProvider with a fake CLI', () => {
    let root: string
    let tmpRoot: string
    let record: string
    let provider: CodexProvider
    const call = (input: string, timeoutMs = 20_000): GenerateCall => ({
        profile,
        settings: {
            concurrency: 1,
            timeoutMs,
        },
        system: 'You are a test.',
        input,
        schema,
        timeoutMs,
        signal: new AbortController().signal,
    })

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'llm-gateway-test-'))
        tmpRoot = join(root, 'tmp')
        mkdirSync(tmpRoot)
        record = join(root, 'record.json')
        process.env.LLM_GATEWAY_TOKEN_FOR_CHILD_TEST = 'must-not-leak'
        provider = new CodexProvider({
            command: [
                process.execPath,
                script,
                record,
            ],
            codexHome: join(root, 'codex-home'),
            tmpRoot,
        })
    })
    afterEach(() => {
        delete process.env.LLM_GATEWAY_TOKEN_FOR_CHILD_TEST
        rmSync(root, {
            recursive: true,
            force: true,
        })
    })

    it('runs codex exec with a strict schema, reads the answer and usage, removes its folder', async () => {
        const result = await provider.generate(call('Say ok.'))
        // The null strict mode forced into the optional `note` is gone again.
        expect(result).toEqual({
            output: {
                ok: true,
            },
            model: 'gpt-6-sol',
            inputTokens: 1200,
            outputTokens: 34,
        })
        const seen = JSON.parse(readFileSync(record, 'utf8'))
        const dir = seen.args[seen.args.indexOf('-C') + 1]
        expect(seen.args).toEqual([
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--ephemeral',
            '--ignore-user-config',
            '--ignore-rules',
            '--sandbox',
            'read-only',
            '--model',
            'gpt-6-sol',
            '--config',
            'model_reasoning_effort="low"',
            '-C',
            dir,
            '--output-schema',
            join(dir, 'schema.json'),
            '--output-last-message',
            join(dir, 'output.json'),
            '-',
        ])
        expect(seen.stdin).toBe('You are a test.\n\nSay ok.')
        expect(seen.schema).toEqual({
            type: 'object',
            properties: {
                ok: {
                    type: 'boolean',
                },
                note: {
                    type: [
                        'string',
                        'null',
                    ],
                },
            },
            required: [
                'ok',
                'note',
            ],
            additionalProperties: false,
        })
        expect(seen.env).toContain('CODEX_HOME')
        expect(seen.env).not.toContain('LLM_GATEWAY_TOKEN_FOR_CHILD_TEST')
        expect(readdirSync(tmpRoot)).toEqual([])
    })

    it("reports the failed turn's message and the stderr ERROR line", async () => {
        await expect(provider.generate(call('[mode:quota]'))).rejects.toThrow(
            "You've hit your usage limit. Try again at 5:03 AM.",
        )
        await expect(provider.generate(call('[mode:stderr]'))).rejects.toThrow('stream disconnected before completion')
        expect(readdirSync(tmpRoot)).toEqual([])
    })

    it('kills a run past its timeout', async () => {
        const started = Date.now()
        const error = await provider.generate(call('[mode:sleep]', 1000)).catch(e => e)
        expect(error).toBeInstanceOf(LlmFailure)
        expect(error.code).toBe('provider_timeout')
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(readdirSync(tmpRoot)).toEqual([])
    })

    it('is available once CODEX_HOME holds a login', () => {
        expect(provider.availability()).toMatch(/not logged in/)
        mkdirSync(join(root, 'codex-home'))
        writeFileSync(join(root, 'codex-home', 'auth.json'), '{}')
        expect(provider.availability()).toBeNull()
    })
})

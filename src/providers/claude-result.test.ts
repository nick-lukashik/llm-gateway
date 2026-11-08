import { describe, expect, it } from 'vitest'
import { LlmFailure } from '../domain/failures.js'
import { claudeArgs, claudeOverrides } from './claude.provider.js'
import { claudeFailure, claudeResult } from './claude-result.js'
import { childEnv } from './provider.js'

describe('claudeResult', () => {
    it('takes the structured output; tokens add up cached input over every model', () => {
        const done = JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            structured_output: {
                caseId: 'F1',
                words: 2,
            },
            modelUsage: {
                'claude-sonnet-5-5': {
                    inputTokens: 40,
                    cacheReadInputTokens: 9000,
                    cacheCreationInputTokens: 1000,
                    outputTokens: 700,
                },
            },
        })
        expect(claudeResult(`${done}\n`)).toEqual({
            output: {
                caseId: 'F1',
                words: 2,
            },
            inputTokens: 10040,
            outputTokens: 700,
            error: null,
        })
        expect(
            claudeResult(
                JSON.stringify({
                    subtype: 'success',
                    is_error: false,
                    result: 'Here: ```json\n{"caseId":"F2"}\n```',
                }),
            ).output,
        ).toEqual({
            caseId: 'F2',
        })
    })

    it('reports a failure inside the run', () => {
        const login = JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'Not logged in · Please run /login',
            modelUsage: {},
        })
        expect(claudeResult(login)).toEqual({
            output: undefined,
            inputTokens: null,
            outputTokens: null,
            error: 'Not logged in · Please run /login',
        })
        expect(
            claudeResult(
                JSON.stringify({
                    subtype: 'error_max_structured_output_retries',
                    is_error: true,
                    errors: [
                        'still invalid',
                    ],
                }),
            ).error,
        ).toBe('Claude gave no result matching the schema: still invalid')
        expect(claudeResult('Segmentation fault').error).toBe('Segmentation fault')
    })

    it('turns a limit into a quota failure and a lost login into one without retry', () => {
        const limit = claudeFailure("You've hit your session limit · resets 3:45pm")
        expect(limit).toBeInstanceOf(LlmFailure)
        expect((limit as LlmFailure).code).toBe('provider_quota')
        expect(limit.message).toContain('resets 3:45pm')
        const login = claudeFailure('Not logged in · Please run /login') as LlmFailure
        expect([
            login.code,
            login.retryable,
        ]).toEqual([
            'provider_unavailable',
            false,
        ])
        expect(claudeFailure('API Error: socket hang up')).not.toBeInstanceOf(LlmFailure)
    })
})

describe('claude command line', () => {
    it('passes a draft-7 schema, no tools and no session', () => {
        const args = claudeArgs(
            {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
            },
            'claude-sonnet-5-5',
            'low',
        )
        expect(args.slice(0, 4)).toEqual([
            '-p',
            '--output-format',
            'json',
            '--json-schema',
        ])
        expect(JSON.parse(args[4] ?? '')).toEqual({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
        })
        expect(args.slice(5, 16)).toEqual([
            '--model',
            'claude-sonnet-5-5',
            '--effort',
            'low',
            '--tools',
            '',
            '--strict-mcp-config',
            '--safe-mode',
            '--no-session-persistence',
            '--max-turns',
            '4',
        ])
    })

    it('never hands API keys or cloud switches to the child', () => {
        const env = childEnv(
            {
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
            },
            {
                PATH: '/usr/bin',
                ANTHROPIC_API_KEY: 'key',
                ANTHROPIC_AUTH_TOKEN: 'token',
                CLAUDE_CODE_USE_BEDROCK: '1',
                LLM_GATEWAY_TOKEN: 'gateway',
                MINIMAX_API_KEY: 'minimax',
            },
        )
        expect(env).toEqual({
            PATH: '/usr/bin',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        })
        for (const key of claudeOverrides) expect(env[key]).toBeUndefined()
    })
})

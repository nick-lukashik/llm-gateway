import { describe, expect, it } from 'vitest'
import { classifyFailure, LlmFailure } from './failures.js'

const code = (message: string) => classifyFailure(new Error(message), 'codex')

describe('classifyFailure', () => {
    it('sorts provider wording into contract codes', () => {
        expect(code("You've hit your usage limit. Try again at 5:03 AM.").code).toBe('provider_quota')
        expect(code('exceeded retry limit, last status: 429 Too Many Requests').code).toBe('provider_quota')
        expect(code("Invalid schema for response_format 'codex_output_schema'").code).toBe('bad_request')
        const login = code('401 Unauthorized: Your access token could not be refreshed')
        expect([
            login.code,
            login.retryable,
        ]).toEqual([
            'provider_unavailable',
            false,
        ])
        expect(code('Codex did not answer: request timed out').code).toBe('provider_timeout')
        const network = code('stream disconnected before completion: error sending request')
        expect([
            network.code,
            network.retryable,
        ]).toEqual([
            'provider_unavailable',
            true,
        ])
        expect(code('something new').code).toBe('provider_unavailable')
    })

    it('keeps a failure as it is and reports a missing CLI as not retryable', () => {
        const failure = new LlmFailure('invalid_output', 'nope')
        expect(classifyFailure(failure, 'codex')).toBe(failure)
        const missing = Object.assign(new Error('spawn codex ENOENT'), {
            code: 'ENOENT',
        })
        expect(classifyFailure(missing, 'codex')).toMatchObject({
            code: 'provider_unavailable',
            retryable: false,
        })
    })

    it('renders the contract body with status', () => {
        const failure = new LlmFailure('provider_quota', 'limit', {
            resetsAt: new Date('2026-10-28T05:04:00Z'),
        })
        expect(failure.status).toBe(429)
        expect(failure.toBody()).toEqual({
            error: 'provider_quota',
            retryable: false,
            message: 'limit',
            resetsAt: '2026-10-28T05:04:00.000Z',
        })
    })
})

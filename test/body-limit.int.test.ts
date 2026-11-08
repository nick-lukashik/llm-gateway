import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_KEY, startApp, type TestApp } from './harness.js'

const MiB = 1024 * 1024
/** BODY_LIMIT of the gateway: prompts reach 600 000 characters. */
const LIMIT = 8 * MiB

/** A JSON body (no messages, so invalid) whose serialized size is exactly `bytes`. */
const bodyOfSize = (bytes: number) => {
    const empty = JSON.stringify({
        model: 't',
        pad: '',
    })
    return JSON.stringify({
        model: 't',
        pad: 'x'.repeat(bytes - empty.length),
    })
}

describe('request body limit (8 MiB)', () => {
    let t: TestApp

    beforeAll(async () => {
        t = await startApp()
    })
    afterAll(async () => {
        await t?.close()
    })

    const post = (contentType: string, body: string) =>
        t.api().post('/api/v1/chat/completions').set('content-type', contentType).send(body)

    it('parses a JSON body of exactly 8 MiB (and then validates it)', async () => {
        const res = await post('application/json', bodyOfSize(LIMIT))
        expect(res.status).toBe(400)
        expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('answers 413 with the contract body above 8 MiB, for JSON and forms', async () => {
        for (const [contentType, body] of [
            [
                'application/json',
                bodyOfSize(LIMIT + 1),
            ],
            [
                'application/x-www-form-urlencoded',
                `model=t&pad=${'x'.repeat(LIMIT)}`,
            ],
        ] as const) {
            const res = await post(contentType, body)
            expect(res.status).toBe(413)
            expect(res.body).toEqual({
                code: 'PAYLOAD_TOO_LARGE',
                message: 'Request body too large',
                requestId: res.headers['x-request-id'],
            })
        }
    })

    it('stops reading a chunked body without content-length at the limit', async () => {
        const { port } = t.app.getHttpServer().address() as AddressInfo
        const status = await new Promise<number>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/api/v1/chat/completions',
                    headers: {
                        'content-type': 'application/json',
                        'transfer-encoding': 'chunked',
                        authorization: `Bearer ${ADMIN_KEY}`,
                    },
                },
                res => {
                    res.resume()
                    resolve(res.statusCode ?? 0)
                },
            )
            // The server may close the socket while we still write: only the answer matters.
            req.on('error', reject)
            req.write('{"model":"t","pad":"')
            const chunk = 'x'.repeat(64 * 1024)
            for (let sent = 0; sent < 2 * LIMIT; sent += chunk.length) req.write(chunk)
            req.end('"}')
        })
        expect(status).toBe(413)
    })
})

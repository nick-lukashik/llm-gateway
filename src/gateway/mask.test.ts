import { describe, expect, it } from 'vitest'
import { MASK, maskSecrets } from './mask.js'

describe('maskSecrets', () => {
    it.each([
        'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
        'sk-ant-api03-abcdefghijklmnopqrstuvwx',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'github_pat_11ABCDEFG0123456789_abcdefghij',
        'xoxb-123456789012-abcdefghijkl',
        'AKIAABCDEFGHIJKLMNOP',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop',
    ])('masks %s', secret => {
        expect(maskSecrets(`before ${secret} after`)).toBe(`before ${MASK} after`)
    })

    it('keeps the Bearer word and masks the token', () => {
        expect(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuv')).toBe(`Authorization: Bearer ${MASK}`)
    })

    it('masks a private key block whole', () => {
        const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----'
        expect(maskSecrets(`x ${key} y`)).toBe(`x ${MASK} y`)
    })

    it('leaves ordinary text alone', () => {
        const text = 'Senior engineer, 6+ years, TypeScript and React; sk- prefix alone is fine'
        expect(maskSecrets(text)).toBe(text)
    })
})

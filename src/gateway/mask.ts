/**
 * Secrets a prompt may carry by accident (a pasted config, a log). The
 * journal keeps texts for 14 days (D-107), never these.
 */
const SECRET_PATTERNS: RegExp[] = [
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
]

export const MASK = '[secret]'

const BEGIN = '-----BEGIN '
const END = '-----END '
const KEY_TAIL = 'PRIVATE KEY-----'

/** PEM private key blocks, found with indexOf: linear, whatever the text (a regex here could backtrack). */
function maskPrivateKeys(text: string): string {
    let out = ''
    let from = 0
    for (;;) {
        const begin = text.indexOf(BEGIN, from)
        if (begin < 0) break
        const headerEnd = text.indexOf(KEY_TAIL, begin)
        // No key header anywhere after this point: nothing left to mask.
        if (headerEnd < 0) break
        const nextBegin = text.indexOf(BEGIN, begin + BEGIN.length)
        // Not a private key header: copy past this BEGIN and look again.
        if (nextBegin >= 0 && headerEnd > nextBegin) {
            out += text.slice(from, begin + BEGIN.length)
            from = begin + BEGIN.length
            continue
        }
        const end = text.indexOf(END, headerEnd)
        const endTail = end < 0 ? -1 : text.indexOf(KEY_TAIL, end)
        if (endTail < 0) break
        out += `${text.slice(from, begin)}${MASK}`
        from = endTail + KEY_TAIL.length
    }
    return out + text.slice(from)
}

export function maskSecrets(text: string): string {
    let masked = maskPrivateKeys(text)
    for (const pattern of SECRET_PATTERNS)
        masked = masked.replace(pattern, (_match, prefix?: string) =>
            typeof prefix === 'string' ? `${prefix}${MASK}` : MASK,
        )
    return masked
}

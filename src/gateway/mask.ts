/**
 * Secrets a prompt may carry by accident (a pasted config, a log). The
 * journal keeps texts for 14 days (D-107), never these.
 */
const SECRET_PATTERNS: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
]

export const MASK = '[secret]'

export function maskSecrets(text: string): string {
    let masked = text
    for (const pattern of SECRET_PATTERNS)
        masked = masked.replace(pattern, (_match, prefix?: string) =>
            typeof prefix === 'string' ? `${prefix}${MASK}` : MASK,
        )
    return masked
}

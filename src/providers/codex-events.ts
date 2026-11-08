export type CodexUsage = {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
}

/** Token usage of the last completed turn and the last reported error in `codex exec --json` output. */
export function codexEvents(stdout: string): {
    usage: CodexUsage | null
    error: string | null
} {
    let usage: CodexUsage | null = null
    let error: string | null = null
    for (const raw of stdout.split('\n')) {
        const line = raw.trim()
        if (!line.startsWith('{')) continue
        try {
            const event = JSON.parse(line) as {
                type?: string
                usage?: CodexUsage
                message?: string
                error?: {
                    message?: string
                }
            }
            if (event.type === 'turn.completed' && event.usage) usage = event.usage
            if (event.type === 'turn.failed' && event.error?.message) error = event.error.message
            else if (event.type === 'error' && event.message) error = event.message
        } catch {}
    }
    return {
        usage,
        error,
    }
}

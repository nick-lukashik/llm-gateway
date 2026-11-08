import { spawn } from 'node:child_process'
import { CallAborted, LlmFailure } from '../domain/failures.js'

export type CliRun = {
    stdout: string
    stderr: string
    code: number | null
}

/**
 * Runs a provider CLI with the prompt on stdin. Output is kept up to a tail
 * limit; on timeout or when the caller leaves the process (and on Linux its
 * whole group) is killed with SIGKILL.
 */
export function runCli(
    command: readonly string[],
    options: {
        name: string
        args: string[]
        stdin: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeoutMs: number
        signal: AbortSignal
        maxStdout?: number
    },
): Promise<CliRun> {
    const [bin, ...prefix] = command
    if (!bin) return Promise.reject(new Error(`${options.name}: empty command`))
    if (options.signal.aborted) return Promise.reject(new CallAborted())
    const maxStdout = options.maxStdout ?? 2_000_000
    const group = process.platform !== 'win32'
    return new Promise((resolve, reject) => {
        const child = spawn(
            bin,
            [
                ...prefix,
                ...options.args,
            ],
            {
                cwd: options.cwd,
                env: options.env,
                stdio: [
                    'pipe',
                    'pipe',
                    'pipe',
                ],
                windowsHide: true,
                detached: group,
            },
        )
        let stdout = ''
        let stderr = ''
        let stopped: Error | undefined
        const kill = (reason: Error) => {
            if (stopped) return
            stopped = reason
            try {
                if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
                else child.kill('SIGKILL')
            } catch {
                child.kill('SIGKILL')
            }
        }
        const timer = setTimeout(
            () =>
                kill(
                    new LlmFailure(
                        'provider_timeout',
                        `${options.name} did not finish in ${Math.round(options.timeoutMs / 1000)} s`,
                    ),
                ),
            options.timeoutMs,
        )
        const onAbort = () => kill(new CallAborted())
        options.signal.addEventListener('abort', onAbort, {
            once: true,
        })
        const done = () => {
            clearTimeout(timer)
            options.signal.removeEventListener('abort', onAbort)
        }
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
            if (stdout.length > maxStdout) stdout = stdout.slice(-maxStdout)
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
            if (stderr.length > 10_000) stderr = stderr.slice(-10_000)
        })
        child.on('error', error => {
            done()
            reject(stopped ?? error)
        })
        child.on('close', code => {
            done()
            if (stopped) reject(stopped)
            else
                resolve({
                    stdout,
                    stderr,
                    code,
                })
        })
        // The CLI may exit before reading all of stdin (a bad flag): not our error.
        child.stdin.on('error', () => undefined)
        child.stdin.end(options.stdin)
    })
}

/** The last `ERROR: …` line a CLI printed on stderr. */
export function lastErrorLine(stderr: string): string | null {
    return (
        [
            ...stderr.matchAll(/^ERROR:\s*(.+)$/gm),
        ]
            .map(match => match[1]?.trim())
            .filter(Boolean)
            .at(-1) ?? null
    )
}

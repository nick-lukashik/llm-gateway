// A stand-in for `codex exec` in tests: node fake-codex.mjs <record.json> exec ... -
// It records its arguments, the schema file and stdin, then acts on a marker in the prompt.
import { readFileSync, writeFileSync } from 'node:fs'

const [record, ...args] = process.argv.slice(2)
const flag = name => args[args.indexOf(name) + 1]
const stdin = readFileSync(0, 'utf8')
writeFileSync(
    record,
    JSON.stringify({
        args,
        cwd: process.cwd(),
        stdin,
        schema: JSON.parse(readFileSync(flag('--output-schema'), 'utf8')),
        env: Object.keys(process.env),
    }),
)

const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)
emit({
    type: 'thread.started',
    thread_id: 't',
})
emit({
    type: 'turn.started',
})

if (stdin.includes('[mode:sleep]')) {
    setTimeout(() => process.exit(0), 30_000)
} else if (stdin.includes('[mode:quota]')) {
    emit({
        type: 'turn.failed',
        error: {
            message: "You've hit your usage limit. Try again at 5:03 AM.",
        },
    })
    process.exit(1)
} else if (stdin.includes('[mode:stderr]')) {
    process.stderr.write('WARN: something\nERROR: stream disconnected before completion\n')
    process.exit(1)
} else {
    // Strict mode: optional fields come back as null.
    writeFileSync(
        flag('--output-last-message'),
        JSON.stringify({
            ok: true,
            note: null,
        }),
    )
    emit({
        type: 'turn.completed',
        usage: {
            input_tokens: 1200,
            cached_input_tokens: 1000,
            output_tokens: 34,
        },
    })
}

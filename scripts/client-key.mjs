// A new client key: `node scripts/client-key.mjs <client> [model,model|*] [--admin]`.
// Prints the key on stdout only (pipe it into kubeseal for the client's secret)
// and the LLM_CLIENTS entry with its SHA-256 on stderr (not a secret: it goes to
// the gateway's ConfigMap). The key is never written to disk.
import { createHash, randomBytes } from 'node:crypto'

const [name, models = '*', ...flags] = process.argv.slice(2)
if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    process.stderr.write('usage: node scripts/client-key.mjs <client> [model,model|*] [--admin]\n')
    process.exit(2)
}
const key = `llm-${name}-${randomBytes(32).toString('base64url')}`
const entry = {
    name,
    keySha256: createHash('sha256').update(key).digest('hex'),
    models: models.split(',').filter(Boolean),
    admin: flags.includes('--admin'),
}
process.stderr.write(`LLM_CLIENTS entry: ${JSON.stringify(entry)}\n`)
process.stdout.write(key)

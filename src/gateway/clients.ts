import { createHash, timingSafeEqual } from 'node:crypto'
import {
    type CanActivate,
    createParamDecorator,
    type ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import type { ClientEntry } from '../config/env.js'

export type Client = {
    name: string
    models: string[]
    admin: boolean
}

type ClientRequest = Request & {
    llmClient?: Client
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Whether a client may call this model: `*` allows every model of the catalog. */
export const mayUse = (client: Client, model: string) => client.models.includes('*') || client.models.includes(model)

/**
 * A key per client (D-106): `Authorization: Bearer <key>`, as with OpenAI.
 * The gateway keeps only SHA-256 hashes (LLM_CLIENTS), so the list is not a
 * secret; the key itself lives in the client's sealed secrets.
 */
@Injectable()
export class ClientKeyGuard implements CanActivate {
    private readonly clients: {
        hash: Buffer
        client: Client
    }[]

    constructor(@Inject(gatewayConfig.KEY) config: GatewayConfig) {
        this.clients = config.clients.map((entry: ClientEntry) => ({
            hash: Buffer.from(entry.keySha256, 'hex'),
            client: {
                name: entry.name,
                models: entry.models,
                admin: entry.admin,
            },
        }))
    }

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<ClientRequest>()
        const header = request.headers.authorization ?? ''
        const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1]
        if (!key) throw new UnauthorizedException('Missing API key: send Authorization: Bearer <key>')
        const hash = Buffer.from(sha256(key), 'hex')
        const found = this.clients.find(entry => timingSafeEqual(entry.hash, hash))
        if (!found) throw new UnauthorizedException('Invalid API key')
        request.llmClient = found.client
        return true
    }
}

/** Admin routes: provider status and pauses. */
@Injectable()
export class AdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const client = context.switchToHttp().getRequest<ClientRequest>().llmClient
        if (!client?.admin) throw new ForbiddenException('This key has no admin rights')
        return true
    }
}

/** The client the key belongs to; set by ClientKeyGuard. */
export const CurrentClient = createParamDecorator((_data: unknown, context: ExecutionContext): Client => {
    const client = context.switchToHttp().getRequest<ClientRequest>().llmClient
    if (!client) throw new UnauthorizedException('Missing API key')
    return client
})

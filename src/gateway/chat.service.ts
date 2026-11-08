import { Injectable } from '@nestjs/common'
import { LlmFailure } from '../domain/failures.js'
import { type Client, mayUse } from './clients.js'
import { GatewayRepository } from './gateway.repository.js'
import { GatewayService } from './gateway.service.js'
import { type ChatCompletion, type ChatRequest, completion, parseChat } from './openai.js'

/** Idempotency-Key as OpenAI takes it: short and printable. */
const IDEMPOTENCY_KEY = /^[\w.:-]{1,200}$/

/** One chat completion for a client: the model, its rights, the idempotent repeat, the call. */
@Injectable()
export class ChatService {
    constructor(
        private readonly gateway: GatewayService,
        private readonly repository: GatewayRepository,
    ) {}

    /** Checks what can be checked before queueing (model, rights, request shape); throws 400 or 403. */
    prepare(client: Client, request: ChatRequest) {
        const model = this.gateway.model(request.model)
        if (!model) throw new LlmFailure('bad_request', `Unknown model ${request.model}; GET /api/v1/models lists them`)
        if (!mayUse(client, model.id)) throw new LlmFailure('bad_request', `This key may not call ${model.id}`)
        return {
            model,
            parsed: parseChat(request, model),
        }
    }

    async complete(
        client: Client,
        request: ChatRequest,
        options: {
            idempotencyKey?: string | undefined
            jobId?: string
            signal: AbortSignal
        },
    ): Promise<ChatCompletion> {
        const { model, parsed } = this.prepare(client, request)
        const key = options.idempotencyKey?.trim() || null
        if (key && !IDEMPOTENCY_KEY.test(key))
            throw new LlmFailure('bad_request', 'Idempotency-Key: 1–200 letters, digits, `.`, `:`, `_` or `-`')
        if (key) {
            const stored = await this.repository.answerFor(client.name, key)
            if (stored) return stored as ChatCompletion
        }
        return this.gateway.generate(
            {
                client: client.name,
                purpose: parsed.purpose,
                model,
                effort: parsed.effort,
                system: parsed.system,
                input: parsed.input,
                schema: parsed.schema,
                journal: parsed.journal,
                idempotencyKey: key,
                jobId: options.jobId ?? null,
            },
            options.signal,
            result => completion(model.id, parsed.textMode, result),
        )
    }
}

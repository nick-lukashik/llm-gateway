import { z } from 'zod'
import { LlmFailure } from '../domain/failures.js'
import type { SchemaObject } from '../domain/json-schema.js'
import type { CatalogModel, Effort } from '../domain/models.js'
import type { CallResult } from './gateway.service.js'
import { maskSecrets } from './mask.js'

/**
 * The OpenAI-compatible request (D-103): `POST /api/v1/chat/completions`.
 * Unknown OpenAI fields (temperature, max tokens…) are accepted and ignored:
 * the subscriptions behind the gateway do not expose them.
 */
const textPart = z.object({
    type: z.literal('text'),
    text: z.string(),
})

const messageSchema = z.object({
    role: z.enum([
        'system',
        'developer',
        'user',
        'assistant',
    ]),
    content: z.union([
        z.string(),
        z.array(textPart).min(1),
    ]),
})

const responseFormatSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('text'),
    }),
    z.object({
        type: z.literal('json_schema'),
        json_schema: z.object({
            name: z.string().min(1).max(64),
            schema: z.record(z.string(), z.unknown()),
            strict: z.boolean().optional(),
        }),
    }),
    z.object({
        type: z.literal('json_object'),
    }),
])

export const chatRequestSchema = z
    .looseObject({
        model: z.string().min(1).max(100),
        messages: z.array(messageSchema).min(1).max(500),
        reasoning_effort: z.string().min(1).max(20).optional(),
        response_format: responseFormatSchema.optional(),
        stream: z.boolean().optional(),
        /** OpenAI metadata; `purpose` names what the call is for in the journal and the logs. */
        metadata: z.record(z.string(), z.string().max(512)).optional(),
    })
    .meta({
        id: 'ChatCompletionRequest',
    })
export type ChatRequest = z.output<typeof chatRequestSchema>

const MAX_SYSTEM = 50_000
const MAX_INPUT = 600_000

/** Without a schema the answer comes back as text through this wrapper: every provider then speaks JSON. */
export const TEXT_SCHEMA: SchemaObject = {
    type: 'object',
    properties: {
        content: {
            type: 'string',
        },
    },
    required: [
        'content',
    ],
    additionalProperties: false,
}

const DEFAULT_SYSTEM = 'You are a helpful assistant. Answer in the `content` field.'

const textOf = (content: z.output<typeof messageSchema>['content']) =>
    typeof content === 'string' ? content : content.map(part => part.text).join('\n')

export type ParsedChat = {
    effort: Effort
    system: string
    input: string
    schema: SchemaObject
    textMode: boolean
    purpose: string | null
    /** The request as the journal keeps it: messages with secrets masked. */
    journal: unknown
}

/** Turns the OpenAI request into one gateway call for this model. */
export function parseChat(request: ChatRequest, model: CatalogModel): ParsedChat {
    if (request.stream) throw new LlmFailure('bad_request', 'stream is not supported yet; send stream: false')
    const format = request.response_format ?? {
        type: 'text' as const,
    }
    if (format.type === 'json_object')
        throw new LlmFailure('bad_request', 'response_format json_object is not supported; send json_schema')

    const effort = (request.reasoning_effort ?? model.defaultEffort) as Effort
    if (!model.efforts.includes(effort))
        throw new LlmFailure(
            'bad_request',
            `reasoning_effort ${request.reasoning_effort} is not supported by ${model.id}: ${model.efforts.join(', ')}`,
        )

    const system = request.messages
        .filter(message => message.role === 'system' || message.role === 'developer')
        .map(message => textOf(message.content))
        .join('\n\n')
    const turns = request.messages.filter(message => message.role === 'user' || message.role === 'assistant')
    if (turns.length === 0) throw new LlmFailure('bad_request', 'messages need at least one user message')
    const only = turns.length === 1 ? turns[0] : undefined
    const input =
        only?.role === 'user'
            ? textOf(only.content)
            : turns.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}:\n${textOf(turn.content)}`).join('\n\n')
    if (system.length > MAX_SYSTEM)
        throw new LlmFailure('bad_request', `system messages exceed ${MAX_SYSTEM} characters`)
    if (input.length > MAX_INPUT) throw new LlmFailure('bad_request', `messages exceed ${MAX_INPUT} characters`)

    const textMode = format.type === 'text'
    return {
        effort,
        system: system || (textMode ? DEFAULT_SYSTEM : 'Return the result as the structured output.'),
        input,
        schema: format.type === 'json_schema' ? format.json_schema.schema : TEXT_SCHEMA,
        textMode,
        purpose: request.metadata?.purpose ?? null,
        journal: {
            messages: request.messages.map(message => ({
                role: message.role,
                content: maskSecrets(textOf(message.content)),
            })),
            reasoning_effort: effort,
            response_format: format,
        },
    }
}

export type ChatCompletion = {
    id: string
    object: 'chat.completion'
    created: number
    model: string
    provider: string
    choices: {
        index: 0
        message: {
            role: 'assistant'
            content: string
        }
        finish_reason: 'stop'
    }[]
    usage: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
    }
}

/** The OpenAI-shaped answer: JSON text for a schema, plain text otherwise. */
export function completion(modelId: string, textMode: boolean, result: CallResult): ChatCompletion {
    const output = result.output as {
        content?: unknown
    }
    const content = textMode ? String(output?.content ?? '') : JSON.stringify(result.output)
    const promptTokens = result.inputTokens ?? 0
    const completionTokens = result.outputTokens ?? 0
    return {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        provider: result.provider,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                },
                finish_reason: 'stop',
            },
        ],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
    }
}

/** The OpenAI error body, plus the gateway's retryable and resets_at. */
export function errorBody(failure: LlmFailure) {
    return {
        error: {
            message: failure.message,
            type: failure.code,
            code: failure.code,
            param: null,
            retryable: failure.retryable,
            resets_at: failure.resetsAt?.toISOString() ?? null,
        },
    }
}

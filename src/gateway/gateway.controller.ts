import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { z } from 'zod'
import { notFound } from '../common/http/app-error.js'
import { ChatService } from './chat.service.js'
import { AdminGuard, type Client, ClientKeyGuard, CurrentClient, mayUse } from './clients.js'
import { GatewayService } from './gateway.service.js'
import { JobsService } from './jobs.service.js'
import { LlmErrorFilter } from './llm-error.filter.js'
import { type ChatRequest, chatRequestSchema } from './openai.js'

/** Aborted when the caller closes the connection before the answer: the provider run stops. */
function callerSignal(response: Response) {
    const controller = new AbortController()
    response.on('close', () => {
        if (!response.writableFinished) controller.abort()
    })
    return controller.signal
}

/**
 * The OpenAI-compatible API (D-103): chat completions, models, plus jobs for
 * long calls (D-104). Base URL for OpenAI SDKs: `http://llm-gateway.prod.svc/api/v1`.
 */
@ApiTags('models')
@ApiBearerAuth()
@UseGuards(ClientKeyGuard)
@UseFilters(LlmErrorFilter)
@Controller()
export class GatewayController {
    constructor(
        private readonly gateway: GatewayService,
        private readonly chat: ChatService,
        private readonly jobs: JobsService,
    ) {}

    @Post('chat/completions')
    @HttpCode(HttpStatus.OK)
    complete(
        @CurrentClient() client: Client,
        @Body({
            schema: chatRequestSchema,
        })
        request: ChatRequest,
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Res({
            passthrough: true,
        })
        response: Response,
    ) {
        return this.chat.complete(client, request, {
            idempotencyKey,
            signal: callerSignal(response),
        })
    }

    @Get('models')
    models(@CurrentClient() client: Client) {
        return {
            object: 'list',
            data: this.gateway
                .models()
                .filter(model => mayUse(client, model.id))
                .map(model => ({
                    id: model.id,
                    object: 'model',
                    created: 0,
                    owned_by: model.provider,
                    label: model.label,
                    efforts: model.efforts,
                    default_effort: model.defaultEffort,
                })),
        }
    }

    @Post('jobs')
    @HttpCode(HttpStatus.ACCEPTED)
    async enqueue(
        @CurrentClient() client: Client,
        @Body({
            schema: chatRequestSchema,
        })
        request: ChatRequest,
    ) {
        const job = await this.jobs.enqueue(client, request)
        return {
            id: job.id,
            object: 'job',
            status: job.status,
            created_at: job.createdAt.toISOString(),
        }
    }

    @Get('jobs/:id')
    async job(@CurrentClient() client: Client, @Param('id') id: string) {
        const job = z.uuid().safeParse(id).success ? await this.jobs.find(client, id) : undefined
        if (!job) throw notFound('Job')
        return {
            id: job.id,
            object: 'job',
            status: job.status,
            created_at: job.createdAt.toISOString(),
            started_at: job.startedAt?.toISOString() ?? null,
            finished_at: job.finishedAt?.toISOString() ?? null,
            result: job.result ?? null,
            error: job.error ?? null,
        }
    }

    @Get('providers')
    @UseGuards(AdminGuard)
    providers() {
        return {
            data: this.gateway.providerList(),
        }
    }

    @Delete('providers/:id/pause')
    @UseGuards(AdminGuard)
    async resume(@Param('id') id: string) {
        const status = await this.gateway.resume(id)
        if (!status) throw notFound('Provider')
        return status
    }
}

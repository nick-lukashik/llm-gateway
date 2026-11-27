import { applyDecorators, Controller, Get, Inject, Query, UseFilters, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { ApiErrors } from '../common/openapi/openapi.js'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import {
    type ClientsResponse,
    clientsResponseSchema,
    llmErrorSchema,
    type UsageQuery,
    type UsageResponse,
    usageQuerySchema,
    usageResponseSchema,
} from './admin.schemas.js'
import { AdminGuard, ClientKeyGuard } from './clients.js'
import { LlmErrorFilter } from './llm-error.filter.js'
import { UsageRepository } from './usage.repository.js'

/** 401 without a valid key, 403 for a key without `admin: true`. */
const ApiAdminErrors = () =>
    applyDecorators(
        ApiResponse({
            status: 401,
            description: 'Missing or unknown key (invalid_api_key)',
            standardSchema: llmErrorSchema,
        }),
        ApiResponse({
            status: 403,
            description: 'The key is not an admin key (permission_denied)',
            standardSchema: llmErrorSchema,
        }),
    )

/**
 * Read-only usage views for the admin (D-168, D-177), for clients with
 * `admin: true` in LLM_CLIENTS: the daily rollup kept without the journal's
 * retention, and each client's tokens today against its daily limit.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(ClientKeyGuard, AdminGuard)
@UseFilters(LlmErrorFilter)
@Controller('admin')
export class AdminController {
    constructor(
        private readonly usage: UsageRepository,
        @Inject(gatewayConfig.KEY) private readonly config: GatewayConfig,
    ) {}

    @Get('usage')
    @ApiOperation({
        summary: 'Calls, errors, tokens and time over a UTC day range, filtered and grouped',
    })
    @ApiOkResponse({
        standardSchema: usageResponseSchema,
    })
    @ApiAdminErrors()
    @ApiErrors(400)
    async usageReport(
        @Query({
            schema: usageQuerySchema,
        })
        query: UsageQuery,
    ): Promise<UsageResponse> {
        const rows = await this.usage.query(query, query.group_by)
        return {
            from: query.from,
            to: query.to,
            groupBy: query.group_by,
            data: rows.map(({ durationMs, ...row }) => ({
                ...row,
                seconds: durationMs / 1000,
            })) as UsageResponse['data'],
        }
    }

    @Get('clients')
    @ApiOperation({
        summary: 'Clients of LLM_CLIENTS (no key hashes), their daily token limit and the tokens used today',
    })
    @ApiOkResponse({
        standardSchema: clientsResponseSchema,
    })
    @ApiAdminErrors()
    @ApiErrors()
    async clients(): Promise<ClientsResponse> {
        const tokens = await this.usage.tokensTodayByClient()
        return {
            data: this.config.clients.map(client => ({
                name: client.name,
                admin: client.admin,
                models: client.models,
                dailyTokens: client.dailyTokens ?? null,
                tokensToday: tokens.get(client.name) ?? 0,
            })),
        }
    }
}

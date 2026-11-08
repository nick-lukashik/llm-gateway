import { fileURLToPath } from 'node:url'
import { Module } from '@nestjs/common'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import { loadCatalog } from '../domain/models.js'
import { ClaudeProvider } from '../providers/claude.provider.js'
import { CodexProvider } from '../providers/codex.provider.js'
import { MinimaxProvider } from '../providers/minimax.provider.js'
import { LLM_PROVIDERS } from '../providers/provider.js'
import { ChatService } from './chat.service.js'
import { AdminGuard, ClientKeyGuard } from './clients.js'
import { GatewayController } from './gateway.controller.js'
import { GatewayRepository } from './gateway.repository.js'
import { CATALOG, GatewayService } from './gateway.service.js'
import { JobsService } from './jobs.service.js'
import { GatewayMetrics } from './metrics.js'

/** config/models.json at the project root, from src/gateway or dist/gateway alike. */
export const defaultCatalogPath = fileURLToPath(new URL('../../config/models.json', import.meta.url))

@Module({
    controllers: [
        GatewayController,
    ],
    providers: [
        {
            provide: CATALOG,
            inject: [
                gatewayConfig.KEY,
            ],
            useFactory: (config: GatewayConfig) => loadCatalog(config.modelsPath ?? defaultCatalogPath),
        },
        {
            provide: LLM_PROVIDERS,
            inject: [
                gatewayConfig.KEY,
            ],
            useFactory: (config: GatewayConfig) => [
                new CodexProvider({
                    command: config.codexCommand,
                    codexHome: config.codexHome,
                }),
                new ClaudeProvider({
                    command: config.claudeCommand,
                    oauthToken: config.claudeToken,
                }),
                new MinimaxProvider({
                    apiKey: config.minimaxKey,
                }),
            ],
        },
        ClientKeyGuard,
        AdminGuard,
        GatewayMetrics,
        GatewayRepository,
        GatewayService,
        ChatService,
        JobsService,
    ],
})
export class GatewayModule {}

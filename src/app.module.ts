import { Module } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { DatabaseModule } from './common/database/database.module.js'
import { HealthModule } from './common/health/health.module.js'
import { createLoggerModule } from './common/logging/logger.module.js'
import { MetricsModule } from './common/metrics/metrics.module.js'
import { appConfig, dbConfig } from './config/config.js'
import { AppConfigModule } from './config/config.module.js'
import * as schema from './db/schema.js'
import { GatewayModule } from './gateway/gateway.module.js'

type App = ConfigType<typeof appConfig>

/**
 * The base every service needs. Redis, RabbitMQ (outbox/inbox) and pg-boss
 * are added only by a service that uses them: copy the module from
 * nest-example and add it here (README, "Add a capability").
 */
@Module({
    imports: [
        AppConfigModule,
        createLoggerModule({
            inject: [
                appConfig.KEY,
            ],
            useFactory: (app: App) => ({
                service: app.service,
                version: app.version,
                level: app.logLevel,
            }),
        }),
        HealthModule.forRootAsync({
            inject: [
                appConfig.KEY,
            ],
            useFactory: (app: App) => ({
                shutdownDelayMs: app.shutdownDelayMs,
            }),
        }),
        MetricsModule.forRootAsync({
            inject: [
                appConfig.KEY,
            ],
            useFactory: (app: App) => ({
                service: app.service,
                version: app.version,
                port: app.metricsPort,
            }),
        }),
        DatabaseModule.forRootAsync({
            schema,
            inject: [
                dbConfig.KEY,
                appConfig.KEY,
            ],
            useFactory: (db: ConfigType<typeof dbConfig>, app: App) => ({
                url: db.url,
                max: db.max,
                applicationName: app.service,
            }),
        }),
        GatewayModule,
    ],
})
export class AppModule {}

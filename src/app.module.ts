import { Module } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { DatabaseModule } from './common/database/database.module.js'
import { HealthModule } from './common/health/health.module.js'
import { JobsModule } from './common/jobs/jobs.module.js'
import { createLoggerModule } from './common/logging/logger.module.js'
import { MetricsModule } from './common/metrics/metrics.module.js'
import { appConfig, dbConfig, gatewayConfig } from './config/config.js'
import { AppConfigModule } from './config/config.module.js'
import * as schema from './db/schema.js'
import { GatewayModule } from './gateway/gateway.module.js'

type App = ConfigType<typeof appConfig>

/**
 * The base every service needs plus pg-boss (jobs, D-168). Redis and RabbitMQ
 * (outbox/inbox) are added only by a service that uses them: copy the module
 * from nest-example and add it here (README, "Add a capability").
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
        JobsModule.forRootAsync({
            inject: [
                dbConfig.KEY,
                appConfig.KEY,
                gatewayConfig.KEY,
            ],
            useFactory: (db: ConfigType<typeof dbConfig>, app: App, gateway: ConfigType<typeof gatewayConfig>) => ({
                connectionString: db.url,
                applicationName: `${app.service}-jobs`,
                // Above the workers: the call jobs, the dead-letter and maintenance queues, sends and supervision.
                max: gateway.jobConcurrency + 4,
            }),
        }),
        GatewayModule,
    ],
})
export class AppModule {}

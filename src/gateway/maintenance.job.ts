import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common'
import { PgBoss } from 'pg-boss'
import { PG_BOSS } from '../common/jobs/jobs.module.js'
import { type GatewayConfig, gatewayConfig } from '../config/config.js'
import { GatewayRepository } from './gateway.repository.js'
import { UsageRepository } from './usage.repository.js'

export const MAINTENANCE_QUEUE = 'llm.maintenance'

/**
 * Every 10 minutes and at startup (a pg-boss schedule; `stately`: one queued
 * and one running at most): recomputes the daily usage rollup of the days the
 * journal holds in full, then deletes calls and finished jobs older than
 * LLM_LOG_RETENTION_DAYS (D-107). The rollup is kept (D-168). The order
 * matters: a day leaves the recomputed range before the purge reaches it.
 */
@Injectable()
export class MaintenanceJob implements OnModuleInit, OnApplicationBootstrap {
    private readonly logger = new Logger('LlmMaintenance')

    constructor(
        @Inject(PG_BOSS) private readonly boss: PgBoss,
        private readonly repository: GatewayRepository,
        private readonly usage: UsageRepository,
        @Inject(gatewayConfig.KEY) private readonly config: GatewayConfig,
    ) {}

    async onModuleInit() {
        await this.boss.createQueue(MAINTENANCE_QUEUE, {
            policy: 'stately',
            retryLimit: 3,
            retryDelay: 30,
            retryBackoff: true,
            expireInSeconds: 5 * 60,
        })
    }

    async onApplicationBootstrap() {
        await this.boss.work(MAINTENANCE_QUEUE, async ([job]) => {
            await this.run(job?.id)
        })
        await this.boss.schedule(MAINTENANCE_QUEUE, '*/10 * * * *')
        await this.boss.send(MAINTENANCE_QUEUE, {})
    }

    async run(jobId?: string) {
        const days = this.config.retentionDays
        const rolledUp = await this.usage.rollup(days)
        const deleted = await this.repository.purge(days)
        if (rolledUp > 0 || deleted.calls > 0 || deleted.jobs > 0)
            this.logger.log(
                {
                    jobId,
                    rolledUp,
                    ...deleted,
                    days,
                },
                'Usage rolled up, journal purged',
            )
    }
}

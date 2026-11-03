import { Module } from '@nestjs/common'
import { NotesController } from './notes.controller.js'
import { NotesRepository } from './notes.repository.js'
import { NotesService } from './notes.service.js'

/**
 * Sample module: the layout of a feature (schemas → repository → service →
 * controller) on Postgres. Rename or replace it; its full version with cache,
 * events and a job is in nest-example.
 */
@Module({
    controllers: [
        NotesController,
    ],
    providers: [
        NotesRepository,
        NotesService,
    ],
})
export class NotesModule {}

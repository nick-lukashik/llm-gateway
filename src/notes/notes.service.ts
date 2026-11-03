import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { DB } from '../common/database/database.js'
import { notFound } from '../common/http/app-error.js'
import { cursorCodec } from '../common/http/cursor.js'
import type { Db, NoteRow } from '../db/types.js'
import { NotesRepository } from './notes.repository.js'
import { type CreateNote, type ListNotesQuery, type Note, type NoteList, notesCursorSchema } from './notes.schemas.js'

const cursor = cursorCodec(notesCursorSchema)
const uuid = z.uuid()

const toNote = (row: NoteRow): Note => ({
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
})

@Injectable()
export class NotesService {
    constructor(
        @Inject(DB) private readonly db: Db,
        private readonly repository: NotesRepository,
    ) {}

    /** A transaction even for one insert: follow-ups (an outbox event, a job) join it. */
    async create(input: CreateNote): Promise<Note> {
        const row = await this.db.transaction(tx => this.repository.insert(tx, input))
        return toNote(row)
    }

    /** A malformed id cannot exist: 404 like any other missing note. */
    async get(id: string): Promise<Note> {
        const row = uuid.safeParse(id).success ? await this.repository.findById(id) : undefined
        if (!row) throw notFound('Note')
        return toNote(row)
    }

    async list(query: ListNotesQuery): Promise<NoteList> {
        const after = query.cursor ? cursor.decode(query.cursor) : undefined
        const rows = await this.repository.page(query.limit, after)
        const items = rows.slice(0, query.limit).map(toNote)
        const last = items.at(-1)
        return {
            items,
            nextCursor:
                rows.length > query.limit && last
                    ? cursor.encode({
                          createdAt: last.createdAt,
                          id: last.id,
                      })
                    : null,
        }
    }
}

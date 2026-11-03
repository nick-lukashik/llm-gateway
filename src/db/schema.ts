import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Millisecond precision, so an ISO string from JSON round-trips exactly (cursors). */
const at = (name: string) =>
    timestamp(name, {
        withTimezone: true,
        precision: 3,
    })

/** Table of the sample module (src/notes); replace it with the service's own. */
export const notes = pgTable(
    'notes',
    {
        // PostgreSQL 18 built-in: time-ordered ids, index-friendly.
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        title: text('title').notNull(),
        body: text('body').notNull().default(''),
        createdAt: at('created_at').notNull().defaultNow(),
    },
    t => [
        index('notes_created_at_id_idx').on(t.createdAt.desc(), t.id.desc()),
        check('notes_title_length', sql`char_length(${t.title}) between 1 and 200`),
        check('notes_body_length', sql`char_length(${t.body}) <= 5000`),
    ],
)

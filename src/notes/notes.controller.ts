import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { ApiErrors } from '../common/openapi/openapi.js'
import {
    type CreateNote,
    createNoteSchema,
    type ListNotesQuery,
    listNotesQuerySchema,
    noteListSchema,
    noteSchema,
} from './notes.schemas.js'
import { NotesService } from './notes.service.js'

/** Thin: validation by schema on the parameter, the rest in NotesService. */
@ApiTags('notes')
@ApiHeader({
    name: 'x-request-id',
    required: false,
    description: 'Echoed back; generated when absent',
})
@Controller('notes')
export class NotesController {
    constructor(private readonly notes: NotesService) {}

    @Get()
    @ApiOperation({
        summary: 'Newest notes first, cursor pagination',
    })
    @ApiOkResponse({
        standardSchema: noteListSchema,
    })
    @ApiErrors(400)
    list(
        @Query({
            schema: listNotesQuerySchema,
        })
        query: ListNotesQuery,
    ) {
        return this.notes.list(query)
    }

    @Get(':id')
    @ApiOkResponse({
        standardSchema: noteSchema,
    })
    @ApiErrors(404)
    get(@Param('id') id: string) {
        return this.notes.get(id)
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiCreatedResponse({
        standardSchema: noteSchema,
    })
    @ApiErrors(400, 413)
    create(
        @Body({
            schema: createNoteSchema,
        })
        body: CreateNote,
    ) {
        return this.notes.create(body)
    }
}

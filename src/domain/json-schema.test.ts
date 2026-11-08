import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
    assertSupportedSchema,
    normalizeSchemaForCodex,
    restoreFromCodex,
    SchemaError,
    toDraft7,
    validateJson,
    withoutMeta,
} from './json-schema.js'

const cv = z.object({
    title: z.string().min(1).max(20),
    level: z.enum([
        'junior',
        'senior',
    ]),
    years: z.number().int().min(0).optional(),
    summary: z.string().nullable(),
    tags: z.array(z.string()).max(3),
    contact: z
        .object({
            email: z.email(),
            site: z.url().optional(),
        })
        .optional(),
    kind: z.literal('cv'),
    extra: z
        .union([
            z.string(),
            z.object({
                note: z.string(),
            }),
        ])
        .optional(),
})
const cvSchema = z.toJSONSchema(cv) as Record<string, unknown>

describe('validateJson', () => {
    it('accepts what zod accepts', () => {
        const value = {
            title: 'Engineer',
            level: 'senior',
            summary: null,
            tags: [
                'ts',
            ],
            contact: {
                email: 'a.person@example.com',
            },
            kind: 'cv',
            extra: {
                note: 'x',
            },
        }
        expect(cv.safeParse(value).success).toBe(true)
        expect(validateJson(value, cvSchema)).toEqual([])
    })

    it('names every broken path without quoting the answer', () => {
        const errors = validateJson(
            {
                title: '',
                level: 'lead',
                years: 2.5,
                tags: [
                    'a',
                    'b',
                    'c',
                    4,
                ],
                contact: {
                    email: 'not-an-email',
                    phone: 'secret-123',
                },
                kind: 'letter',
                extra: 7,
            },
            cvSchema,
        )
        expect(errors).toEqual([
            'summary: required',
            'title: at least 1 characters, got 0',
            'level: must be one of "junior", "senior"',
            'years: expected integer, got number',
            'tags: at most 3 items, got 4',
            'tags[3]: expected string, got number',
            expect.stringMatching(/^contact\.email: does not match the pattern/),
            'contact.phone: unexpected property',
            'kind: must be "cv"',
            'extra: matches none of the allowed shapes',
            'extra: expected string, got number',
        ])
        expect(errors.join('\n')).not.toContain('secret-123')
    })

    it('checks types, nullable type lists, $defs and recursive refs', () => {
        expect(
            validateJson('x', {
                type: 'object',
            }),
        ).toEqual([
            '(root): expected object, got string',
        ])
        expect(
            validateJson(null, {
                type: [
                    'string',
                    'null',
                ],
            }),
        ).toEqual([])
        const tree = z.object({
            name: z.string(),
            get children() {
                return z.array(tree)
            },
        })
        const treeSchema = z.toJSONSchema(tree)
        expect(
            validateJson(
                {
                    name: 'a',
                    children: [
                        {
                            name: 'b',
                            children: [],
                        },
                    ],
                },
                treeSchema,
            ),
        ).toEqual([])
        expect(
            validateJson(
                {
                    name: 'a',
                    children: [
                        {
                            name: 1,
                            children: [],
                        },
                    ],
                },
                treeSchema,
            ),
        ).toEqual([
            'children[0].name: expected string, got number',
        ])
        const item = z
            .object({
                id: z.string(),
            })
            .meta({
                id: 'Item',
            })
        const withDefs = z.toJSONSchema(
            z.object({
                a: item,
                b: item,
            }),
        )
        expect(JSON.stringify(withDefs)).toContain('#/$defs/Item')
        expect(
            validateJson(
                {
                    a: {
                        id: '1',
                    },
                    b: {},
                },
                withDefs,
            ),
        ).toEqual([
            'b.id: required',
        ])
    })

    it('rejects schemas it cannot use', () => {
        expect(() =>
            assertSupportedSchema({
                $ref: '#/$defs/missing',
            }),
        ).toThrow(SchemaError)
        expect(() =>
            assertSupportedSchema({
                type: 'text',
            }),
        ).toThrow(SchemaError)
        expect(() =>
            assertSupportedSchema({
                type: 'string',
                pattern: '(',
            }),
        ).toThrow(SchemaError)
        expect(() => assertSupportedSchema([])).toThrow(SchemaError)
        expect(() => assertSupportedSchema(cvSchema)).not.toThrow()
    })
})

describe('normalizeSchemaForCodex', () => {
    it('closes every object, requires every property and makes optional ones nullable', () => {
        const { schema, wrapped } = normalizeSchemaForCodex(withoutMeta(cvSchema))
        expect(wrapped).toBe(false)
        expect(schema).toEqual({
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                },
                level: {
                    type: 'string',
                    enum: [
                        'junior',
                        'senior',
                    ],
                },
                years: {
                    type: [
                        'integer',
                        'null',
                    ],
                    minimum: 0,
                    maximum: 9007199254740991,
                },
                summary: {
                    type: [
                        'string',
                        'null',
                    ],
                },
                tags: {
                    type: 'array',
                    items: {
                        type: 'string',
                    },
                    maxItems: 3,
                },
                contact: {
                    type: [
                        'object',
                        'null',
                    ],
                    properties: {
                        email: {
                            type: 'string',
                            format: 'email',
                        },
                        site: {
                            type: [
                                'string',
                                'null',
                            ],
                        },
                    },
                    required: [
                        'email',
                        'site',
                    ],
                    additionalProperties: false,
                },
                kind: {
                    type: 'string',
                    const: 'cv',
                },
                extra: {
                    anyOf: [
                        {
                            type: 'string',
                        },
                        {
                            type: 'object',
                            properties: {
                                note: {
                                    type: 'string',
                                },
                            },
                            required: [
                                'note',
                            ],
                            additionalProperties: false,
                        },
                        {
                            type: 'null',
                        },
                    ],
                },
            },
            required: [
                'title',
                'level',
                'years',
                'summary',
                'tags',
                'contact',
                'kind',
                'extra',
            ],
            additionalProperties: false,
        })
    })

    it('closes objects z.toJSONSchema leaves open (input mode) and nullable enums', () => {
        const open = {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: [
                        'a',
                        'b',
                    ],
                },
                nested: {
                    type: 'object',
                    properties: {
                        x: {
                            type: 'number',
                        },
                    },
                },
            },
        }
        expect(normalizeSchemaForCodex(open).schema).toEqual({
            type: 'object',
            properties: {
                mode: {
                    anyOf: [
                        {
                            type: 'string',
                            enum: [
                                'a',
                                'b',
                            ],
                        },
                        {
                            type: 'null',
                        },
                    ],
                },
                nested: {
                    type: [
                        'object',
                        'null',
                    ],
                    properties: {
                        x: {
                            type: [
                                'number',
                                'null',
                            ],
                        },
                    },
                    required: [
                        'x',
                    ],
                    additionalProperties: false,
                },
            },
            required: [
                'mode',
                'nested',
            ],
            additionalProperties: false,
        })
    })

    it('wraps a root that is not a plain object and keeps $defs reachable', () => {
        const list = z.toJSONSchema(
            z.array(
                z
                    .object({
                        id: z.string(),
                    })
                    .meta({
                        id: 'Row',
                    }),
            ),
        ) as Record<string, unknown>
        const { schema, wrapped } = normalizeSchemaForCodex(withoutMeta(list))
        expect(wrapped).toBe(true)
        expect(schema).toMatchObject({
            type: 'object',
            properties: {
                value: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/Row',
                    },
                },
            },
            required: [
                'value',
            ],
            additionalProperties: false,
            $defs: {
                Row: {
                    type: 'object',
                    required: [
                        'id',
                    ],
                    additionalProperties: false,
                },
            },
        })
        expect(
            restoreFromCodex(
                {
                    value: [
                        {
                            id: '1',
                        },
                    ],
                },
                list,
                true,
            ),
        ).toEqual([
            {
                id: '1',
            },
        ])
    })

    it('restores the answer: forced nulls of optional fields go, real nulls stay', () => {
        const answer = {
            title: 'Engineer',
            level: 'senior',
            years: null,
            summary: null,
            tags: [],
            contact: {
                email: 'a.person@example.com',
                site: null,
            },
            kind: 'cv',
            extra: null,
        }
        const restored = restoreFromCodex(answer, cvSchema, false)
        expect(restored).toEqual({
            title: 'Engineer',
            level: 'senior',
            summary: null,
            tags: [],
            contact: {
                email: 'a.person@example.com',
            },
            kind: 'cv',
        })
        expect(cv.safeParse(restored).success).toBe(true)
        expect(validateJson(restored, cvSchema)).toEqual([])
    })
})

describe('toDraft7', () => {
    it('moves $defs to definitions and tuples to items lists', () => {
        const schema = {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
                pair: {
                    type: 'array',
                    prefixItems: [
                        {
                            type: 'string',
                        },
                        {
                            type: 'number',
                        },
                    ],
                    items: false,
                },
                row: {
                    $ref: '#/$defs/Row',
                },
            },
            $defs: {
                Row: {
                    type: 'object',
                },
            },
        }
        expect(toDraft7(schema)).toEqual({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
                pair: {
                    type: 'array',
                    items: [
                        {
                            type: 'string',
                        },
                        {
                            type: 'number',
                        },
                    ],
                    additionalItems: false,
                },
                row: {
                    $ref: '#/definitions/Row',
                },
            },
            definitions: {
                Row: {
                    type: 'object',
                },
            },
        })
    })
})

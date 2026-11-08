import type { SchemaObject } from './json-schema.js'

type Schema = SchemaObject

/** The first JSON object in a text answer; a model may wrap it in a code fence or explain around it. */
export function jsonFromText(text: string): unknown {
    const body = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '')
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) return text
    try {
        return JSON.parse(body.slice(start, end + 1))
    } catch {
        return text
    }
}

/** A string of identifiers ("R1, R3") or of lines becomes their list; any other text stays one item. */
function listFromText(text: string): string[] {
    if (text.includes('\n'))
        return text
            .split('\n')
            .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
            .filter(Boolean)
    const parts = text.split(/\s*[,;]\s*/).filter(Boolean)
    return parts.every(part => /^\S{1,40}$/.test(part))
        ? parts
        : [
              text,
          ]
}

function parsedText(text: string, open: string): unknown {
    if (!text.trim().startsWith(open)) return undefined
    try {
        return JSON.parse(text) as unknown
    } catch {
        return undefined
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Brings a result closer to its schema before validation (ported from Work
 * Finder, for providers without a strict JSON mode). Models write a list of
 * ids as one string ("R1, R3"), numbers as strings, objects as JSON text, or
 * add keys the schema forbids. Validation runs afterwards, so this cannot
 * make an invalid result pass; it only removes these mechanical slips.
 */
export function coerceToSchema(value: unknown, schema: Schema, root: Schema = schema, depth = 0): unknown {
    if (depth > 64) return value
    const next = (item: unknown, child: Schema) => coerceToSchema(item, child, root, depth + 1)
    if (typeof schema.$ref === 'string') {
        const name = schema.$ref.replace(/^#\/(?:\$defs|definitions)\//, '')
        const target =
            schema.$ref === '#'
                ? root
                : ((root.$defs as Record<string, Schema> | undefined)?.[name]
                  ?? (root.definitions as Record<string, Schema> | undefined)?.[name])
        return target ? next(value, target) : value
    }
    const variants = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined
    if (variants) {
        if (value === null && variants.some(variant => variant.type === 'null')) return null
        const concrete = variants.filter(variant => variant.type !== 'null')
        return concrete.length === 1 && concrete[0] ? next(value, concrete[0]) : value
    }
    if (Array.isArray(schema.type)) {
        // A simple nullable field is type: ["string", "null"].
        if (value === null && schema.type.includes('null')) return null
        const concrete = (schema.type as string[]).filter(type => type !== 'null')
        return concrete.length === 1
            ? next(value, {
                  ...schema,
                  type: concrete[0],
              })
            : value
    }
    switch (schema.type) {
        case 'array': {
            const items = (schema.items ?? {}) as Schema
            if (typeof value === 'string') {
                const json = parsedText(value, '[')
                if (Array.isArray(json)) return json.map(item => next(item, items))
                if (!value.trim()) return []
                return items.type === 'string'
                    ? listFromText(value.trim())
                    : [
                          next(value, items),
                      ]
            }
            if (Array.isArray(value)) return value.map(item => next(item, items))
            if (isPlainObject(value)) {
                const entries = Object.entries(value)
                // A list wrapped in an object with one field ({"items": [...]}).
                const only = entries.length === 1 ? entries[0] : undefined
                if (only && Array.isArray(only[1])) return next(only[1], schema)
                // Labelled rows as a map ({"Frontend": [...]}) instead of [{"label": "Frontend", "items": [...]}].
                const rowProperties = (items.properties ?? {}) as Record<string, Schema>
                if ('label' in rowProperties)
                    return entries.map(([label, row]) =>
                        next(
                            Array.isArray(row) && 'items' in rowProperties
                                ? {
                                      label,
                                      items: row,
                                  }
                                : isPlainObject(row)
                                  ? {
                                        label,
                                        ...row,
                                    }
                                  : {
                                        label,
                                        value: row,
                                    },
                            items,
                        ),
                    )
            }
            return value
        }
        case 'object': {
            const object = typeof value === 'string' ? (parsedText(value, '{') ?? value) : value
            if (!isPlainObject(object)) return object
            const properties = (schema.properties ?? {}) as Record<string, Schema>
            const result: Record<string, unknown> = Object.fromEntries(
                Object.entries(object)
                    .filter(([key]) => key in properties || schema.additionalProperties !== false)
                    .map(([key, item]) => {
                        const property = properties[key]
                        return [
                            key,
                            property ? next(item, property) : item,
                        ]
                    }),
            )
            // A required list the model left out is empty; a required nullable field is null.
            for (const key of (schema.required ?? []) as string[]) {
                const property = properties[key]
                if (key in result || !property) continue
                const options = (property.anyOf ?? property.oneOf ?? []) as Schema[]
                if (property.type === 'array') result[key] = []
                else if (
                    options.some(option => option.type === 'null')
                    || (Array.isArray(property.type) && property.type.includes('null'))
                )
                    result[key] = null
            }
            return result
        }
        case 'number':
        case 'integer':
            return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
                ? Number(value)
                : value
        case 'boolean':
            return typeof value === 'string' && /^(true|false)$/i.test(value.trim())
                ? value.trim().toLowerCase() === 'true'
                : value
        case 'string':
            return typeof value === 'number' ? String(value) : value
        default:
            return value
    }
}

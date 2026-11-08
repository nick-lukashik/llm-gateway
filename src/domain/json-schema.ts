/**
 * The JSON Schema subset z.toJSONSchema emits (draft 2020-12): enough to
 * check a model's answer against the schema of the request and to rewrite
 * that schema for a provider. Messages name paths and expectations, never
 * values of the answer.
 */
export type JsonSchema = boolean | SchemaObject
export type SchemaObject = {
    [key: string]: unknown
}

/** The request's schema cannot be used (bad $ref, pattern, type). */
export class SchemaError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SchemaError'
    }
}

const TYPES = new Set([
    'null',
    'boolean',
    'object',
    'array',
    'number',
    'integer',
    'string',
])
const MAX_ERRORS = 20
const MAX_DEPTH = 256

const isObject = (value: unknown): value is SchemaObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const typesOf = (schema: SchemaObject): string[] | undefined =>
    typeof schema.type === 'string'
        ? [
              schema.type,
          ]
        : Array.isArray(schema.type)
          ? (schema.type as string[])
          : undefined

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
    if (isObject(a) && isObject(b)) {
        const keys = Object.keys(a)
        return keys.length === Object.keys(b).length && keys.every(key => key in b && deepEqual(a[key], b[key]))
    }
    return false
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'null':
            return value === null
        case 'boolean':
            return typeof value === 'boolean'
        case 'object':
            return isObject(value)
        case 'array':
            return Array.isArray(value)
        case 'number':
            return typeof value === 'number' && Number.isFinite(value)
        case 'integer':
            return Number.isInteger(value)
        case 'string':
            return typeof value === 'string'
        default:
            return false
    }
}

const decodePointer = (segment: string) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~')

/** Resolves a local `$ref` (`#`, `#/$defs/x`, any JSON pointer in the document). */
export function resolveRef(root: JsonSchema, ref: string): JsonSchema {
    if (ref === '#') return root
    if (!ref.startsWith('#/')) throw new SchemaError(`Unsupported $ref ${ref.slice(0, 100)}`)
    let node: unknown = root
    for (const segment of ref.slice(2).split('/').map(decodePointer)) {
        if (Array.isArray(node)) node = node[Number(segment)]
        else if (isObject(node)) node = node[segment]
        else node = undefined
        if (node === undefined) throw new SchemaError(`Unresolvable $ref ${ref.slice(0, 100)}`)
    }
    if (typeof node !== 'boolean' && !isObject(node)) throw new SchemaError(`$ref ${ref.slice(0, 100)} is not a schema`)
    return node
}

/**
 * `pattern` comes from the client's schema. Clients are platform services
 * with a key, but a pattern with catastrophic backtracking would still stall
 * the process: only short patterns without nested quantifiers or
 * backreferences are accepted, and values are tested up to a length.
 */
const MAX_PATTERN = 256
export const MAX_PATTERN_INPUT = 10_000
/** A quantified group that itself ends in a quantifier, `(a+)+` or `(\\w*)*`: the classic catastrophic shape. */
const NESTED_QUANTIFIER = /\([^()]*[+*?]\)\s*[+*{]/
const BACKREFERENCE = /\\[1-9]|\\k</

const patterns = new Map<string, RegExp>()
function compilePattern(source: string): RegExp {
    let compiled = patterns.get(source)
    if (compiled) return compiled
    if (source.length > MAX_PATTERN) throw new SchemaError(`pattern longer than ${MAX_PATTERN} characters`)
    if (NESTED_QUANTIFIER.test(source) || BACKREFERENCE.test(source))
        throw new SchemaError(`pattern ${source.slice(0, 100)} has nested quantifiers or backreferences`)
    try {
        compiled = new RegExp(source, 'u')
    } catch {
        try {
            compiled = new RegExp(source)
        } catch {
            throw new SchemaError(`Invalid pattern ${source.slice(0, 100)}`)
        }
    }
    patterns.set(source, compiled)
    return compiled
}

const childSchemaKeys = [
    'items',
    'additionalProperties',
    'propertyNames',
    'not',
    'contains',
] as const
const childListKeys = [
    'anyOf',
    'oneOf',
    'allOf',
    'prefixItems',
] as const
const childMapKeys = [
    'properties',
    '$defs',
    'definitions',
] as const

/** Every sub-schema of `schema`, for walks over the whole document. */
function forEachChild(schema: SchemaObject, visit: (child: unknown, key: string) => void) {
    for (const key of childSchemaKeys) if (key in schema) visit(schema[key], key)
    for (const key of childListKeys)
        if (Array.isArray(schema[key])) for (const child of schema[key] as unknown[]) visit(child, key)
    for (const key of childMapKeys)
        if (isObject(schema[key])) for (const child of Object.values(schema[key] as SchemaObject)) visit(child, key)
}

/**
 * Rejects a schema the gateway cannot check: a non-object root document,
 * unknown types, unresolvable `$ref`s, patterns JavaScript cannot compile.
 */
export function assertSupportedSchema(root: unknown): asserts root is SchemaObject {
    if (!isObject(root)) throw new SchemaError('The schema must be an object')
    const walk = (node: unknown, depth: number) => {
        if (depth > MAX_DEPTH) throw new SchemaError('The schema is nested too deep')
        if (typeof node === 'boolean') return
        if (!isObject(node)) throw new SchemaError('A sub-schema is not an object')
        const types = node.type === undefined ? [] : typesOf(node)
        if (!types || types.some(type => !TYPES.has(type))) throw new SchemaError('Unknown type in the schema')
        if (typeof node.$ref === 'string') resolveRef(root, node.$ref)
        else if (node.$ref !== undefined) throw new SchemaError('$ref must be a string')
        if (typeof node.pattern === 'string') compilePattern(node.pattern)
        if (node.required !== undefined && !Array.isArray(node.required))
            throw new SchemaError('required must be a list')
        forEachChild(node, child => walk(child, depth + 1))
    }
    walk(root, 0)
}

const at = (path: string) => path || '(root)'
const describe = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 80)

type Context = {
    root: JsonSchema
    errors: string[]
    depth: number
}

function check(value: unknown, schema: JsonSchema, path: string, ctx: Context) {
    if (ctx.errors.length >= MAX_ERRORS) return
    if (schema === true) return
    if (schema === false) {
        ctx.errors.push(`${at(path)}: not allowed here`)
        return
    }
    if (++ctx.depth > MAX_DEPTH) throw new SchemaError('The schema recurses too deep')
    try {
        checkObject(value, schema, path, ctx)
    } finally {
        ctx.depth--
    }
}

/** Errors `value` would raise against `schema`, without touching `ctx`. */
function errorsIn(value: unknown, schema: JsonSchema, path: string, ctx: Context) {
    const local: Context = {
        root: ctx.root,
        errors: [],
        depth: ctx.depth,
    }
    check(value, schema, path, local)
    return local.errors
}

function checkObject(value: unknown, schema: SchemaObject, path: string, ctx: Context) {
    const { errors } = ctx
    if (typeof schema.$ref === 'string') check(value, resolveRef(ctx.root, schema.$ref), path, ctx)

    const types = typesOf(schema)
    if (types && !types.some(type => matchesType(value, type))) {
        errors.push(`${at(path)}: expected ${types.join(' or ')}, got ${describe(value)}`)
        return
    }
    if ('const' in schema && !deepEqual(value, schema.const)) {
        errors.push(`${at(path)}: must be ${show(schema.const)}`)
        return
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(item => deepEqual(value, item))) {
        errors.push(`${at(path)}: must be one of ${schema.enum.map(show).join(', ').slice(0, 300)}`)
        return
    }

    if (Array.isArray(schema.anyOf)) {
        const branches = (schema.anyOf as JsonSchema[]).map(branch => errorsIn(value, branch, path, ctx))
        if (!branches.some(branchErrors => branchErrors.length === 0)) {
            const closest = branches.reduce((best, item) => (item.length < best.length ? item : best))
            errors.push(`${at(path)}: matches none of the allowed shapes`, ...closest)
        }
    }
    if (Array.isArray(schema.oneOf)) {
        const matching = (schema.oneOf as JsonSchema[]).filter(
            branch => errorsIn(value, branch, path, ctx).length === 0,
        ).length
        if (matching !== 1) errors.push(`${at(path)}: must match exactly one allowed shape, matches ${matching}`)
    }
    if (Array.isArray(schema.allOf)) for (const branch of schema.allOf as JsonSchema[]) check(value, branch, path, ctx)
    if (schema.not !== undefined && errorsIn(value, schema.not as JsonSchema, path, ctx).length === 0)
        errors.push(`${at(path)}: matches a forbidden shape`)

    if (typeof value === 'string') checkString(value, schema, path, errors)
    else if (typeof value === 'number') checkNumber(value, schema, path, errors)
    else if (Array.isArray(value)) checkArray(value, schema, path, ctx)
    else if (isObject(value)) checkProperties(value, schema, path, ctx)
}

function checkString(value: string, schema: SchemaObject, path: string, errors: string[]) {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
        errors.push(`${at(path)}: at least ${schema.minLength} characters, got ${value.length}`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
        errors.push(`${at(path)}: at most ${schema.maxLength} characters, got ${value.length}`)
    if (
        typeof schema.pattern === 'string'
        && (value.length > MAX_PATTERN_INPUT || !compilePattern(schema.pattern).test(value))
    )
        errors.push(`${at(path)}: does not match the pattern ${schema.pattern.slice(0, 120)}`)
}

function checkNumber(value: number, schema: SchemaObject, path: string, errors: string[]) {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
        errors.push(`${at(path)}: must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum)
        errors.push(`${at(path)}: must be <= ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
        errors.push(`${at(path)}: must be > ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
        errors.push(`${at(path)}: must be < ${schema.exclusiveMaximum}`)
    if (
        typeof schema.multipleOf === 'number'
        && schema.multipleOf > 0
        && !Number.isInteger(Number((value / schema.multipleOf).toPrecision(12)))
    )
        errors.push(`${at(path)}: must be a multiple of ${schema.multipleOf}`)
}

function checkArray(value: unknown[], schema: SchemaObject, path: string, ctx: Context) {
    const { errors } = ctx
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
        errors.push(`${at(path)}: at least ${schema.minItems} items, got ${value.length}`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
        errors.push(`${at(path)}: at most ${schema.maxItems} items, got ${value.length}`)
    const prefix = Array.isArray(schema.prefixItems) ? (schema.prefixItems as JsonSchema[]) : []
    value.forEach((item, index) => {
        const itemSchema = index < prefix.length ? prefix[index] : (schema.items as JsonSchema | undefined)
        if (itemSchema !== undefined) check(item, itemSchema, `${path}[${index}]`, ctx)
    })
    if (schema.uniqueItems === true)
        for (let i = 0; i < value.length; i++)
            for (let j = i + 1; j < value.length; j++)
                if (deepEqual(value[i], value[j])) {
                    errors.push(`${at(path)}: items ${i} and ${j} are the same`)
                    return
                }
}

function checkProperties(value: SchemaObject, schema: SchemaObject, path: string, ctx: Context) {
    const { errors } = ctx
    const properties = isObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {}
    const keys = Object.keys(value)
    for (const key of (schema.required ?? []) as string[])
        if (!(key in value)) errors.push(`${path ? `${path}.` : ''}${key}: required`)
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties)
        errors.push(`${at(path)}: at least ${schema.minProperties} properties`)
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties)
        errors.push(`${at(path)}: at most ${schema.maxProperties} properties`)
    for (const key of keys) {
        const child = `${path ? `${path}.` : ''}${key}`
        if (schema.propertyNames !== undefined) check(key, schema.propertyNames as JsonSchema, `${child} (name)`, ctx)
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined
        if (property !== undefined) check(value[key], property, child, ctx)
        else if (schema.additionalProperties === false) errors.push(`${child}: unexpected property`)
        else if (isObject(schema.additionalProperties)) check(value[key], schema.additionalProperties, child, ctx)
    }
}

/**
 * What is wrong with `value` against `schema` (at most 20 lines); empty when
 * it matches. Throws SchemaError for a schema the gateway cannot use.
 */
export function validateJson(value: unknown, schema: JsonSchema): string[] {
    const ctx: Context = {
        root: schema,
        errors: [],
        depth: 0,
    }
    check(value, schema, '', ctx)
    return ctx.errors.slice(0, MAX_ERRORS)
}

/** Whether `schema` itself lets `null` through (not looking into $refs). */
export function acceptsNull(schema: JsonSchema | undefined): boolean {
    if (schema === undefined || schema === true) return true
    if (schema === false) return false
    if (typesOf(schema)?.includes('null')) return true
    if ('const' in schema) return schema.const === null
    if (Array.isArray(schema.enum)) return schema.enum.includes(null)
    const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined
    if (Array.isArray(variants)) return variants.some(acceptsNull)
    return schema.type === undefined && schema.$ref === undefined && !('allOf' in schema)
}

/* ---------- Codex: strict structured outputs ---------- */

/** What OpenAI strict mode accepts in a schema; the rest is dropped (and still checked afterwards). */
const STRICT_KEYS = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    '$ref',
    '$defs',
    'definitions',
    'description',
    'title',
    'pattern',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minItems',
    'maxItems',
])
const STRICT_FORMATS = new Set([
    'date-time',
    'time',
    'date',
    'duration',
    'email',
    'hostname',
    'ipv4',
    'ipv6',
    'uuid',
])
/** The property a non-object root is wrapped in. */
export const CODEX_WRAP_KEY = 'value'

function nullable(schema: JsonSchema): JsonSchema {
    if (acceptsNull(schema)) return schema
    if (typeof schema === 'boolean') return schema
    if (typeof schema.type === 'string' && !('enum' in schema) && !('const' in schema))
        return {
            ...schema,
            type: [
                schema.type,
                'null',
            ],
        }
    if (Array.isArray(schema.type) && !('enum' in schema) && !('const' in schema))
        return {
            ...schema,
            type: [
                ...(schema.type as string[]),
                'null',
            ],
        }
    if (Array.isArray(schema.anyOf) && Object.keys(schema).length === 1)
        return {
            anyOf: [
                ...(schema.anyOf as JsonSchema[]),
                {
                    type: 'null',
                },
            ],
        }
    return {
        anyOf: [
            schema,
            {
                type: 'null',
            },
        ],
    }
}

function strictNode(node: unknown, rewriteRef: (ref: string) => string): unknown {
    if (Array.isArray(node)) return node.map(item => strictNode(item, rewriteRef))
    if (!isObject(node)) return node
    const out: SchemaObject = {}
    for (const [key, value] of Object.entries(node)) {
        if (key === 'oneOf') {
            // Strict mode knows anyOf only; the original oneOf is checked afterwards.
            out.anyOf = strictNode(value, rewriteRef)
            continue
        }
        if (!STRICT_KEYS.has(key)) continue
        if (key === 'format' && !STRICT_FORMATS.has(String(value))) continue
        if (key === 'pattern' && typeof node.format === 'string') continue
        if (key === '$ref') out.$ref = rewriteRef(String(value))
        else if (key === 'properties' || key === '$defs' || key === 'definitions')
            out[key] = Object.fromEntries(
                Object.entries(value as SchemaObject).map(([name, child]) => [
                    name,
                    strictNode(child, rewriteRef),
                ]),
            )
        else if (key === 'items' || key === 'additionalProperties' || key === 'anyOf')
            out[key] = strictNode(value, rewriteRef)
        else out[key] = value
    }
    if (Array.isArray(node.prefixItems)) {
        // No tuples in strict mode: any of the positions' shapes, order checked afterwards.
        const shapes = [
            ...node.prefixItems,
            ...(isObject(node.items)
                ? [
                      node.items,
                  ]
                : []),
        ]
        out.items = {
            anyOf: strictNode(shapes, rewriteRef),
        }
    }
    const isObjectSchema =
        out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || isObject(out.properties)
    if (isObjectSchema) {
        const properties = (out.properties ?? {}) as Record<string, JsonSchema>
        const required = new Set((node.required ?? []) as string[])
        out.properties = Object.fromEntries(
            Object.entries(properties).map(([name, child]) => [
                name,
                required.has(name) ? child : nullable(child),
            ]),
        )
        out.required = Object.keys(properties)
        if (out.additionalProperties === undefined || out.additionalProperties === true)
            out.additionalProperties = false
    }
    return out
}

/**
 * Rewrites a request schema for `codex exec --output-schema`, which sends it
 * to OpenAI in strict mode: every object closed (`additionalProperties:
 * false`) with every property required, an optional property becomes
 * nullable (`restoreFromCodex` drops those nulls again), unsupported keywords
 * (lengths, defaults, unknown formats) are dropped, oneOf becomes anyOf, and
 * a root that is not a plain object is wrapped in `{ value: … }`.
 */
export function normalizeSchemaForCodex(schema: SchemaObject): {
    schema: SchemaObject
    wrapped: boolean
} {
    const wrapped = schema.type !== 'object' || 'anyOf' in schema || 'oneOf' in schema
    if (!wrapped)
        return {
            schema: strictNode(schema, ref => ref) as SchemaObject,
            wrapped,
        }
    const { $defs, definitions, $schema: _drop, ...body } = schema
    const prefix = `#/properties/${CODEX_WRAP_KEY}`
    const rewriteRef = (ref: string) =>
        ref.startsWith('#/$defs/') || ref.startsWith('#/definitions/')
            ? ref
            : ref === '#' || ref.startsWith('#/')
              ? `${prefix}${ref.slice(1)}`
              : ref
    const wrapper: SchemaObject = {
        type: 'object',
        properties: {
            [CODEX_WRAP_KEY]: body,
        },
        required: [
            CODEX_WRAP_KEY,
        ],
        additionalProperties: false,
        ...($defs
            ? {
                  $defs,
              }
            : {}),
        ...(definitions
            ? {
                  definitions,
              }
            : {}),
    }
    return {
        schema: strictNode(wrapper, rewriteRef) as SchemaObject,
        wrapped,
    }
}

/**
 * Codex's answer back in the shape of the request schema: unwrapped, and
 * without the nulls strict mode forced into optional properties that do not
 * accept null.
 */
export function restoreFromCodex(output: unknown, schema: SchemaObject, wrapped: boolean): unknown {
    const value = wrapped && isObject(output) && CODEX_WRAP_KEY in output ? output[CODEX_WRAP_KEY] : output
    return stripAddedNulls(value, schema, schema, 0)
}

function stripAddedNulls(value: unknown, schema: JsonSchema, root: JsonSchema, depth: number): unknown {
    if (typeof schema === 'boolean' || depth > MAX_DEPTH) return value
    if (typeof schema.$ref === 'string') {
        let target: JsonSchema
        try {
            target = resolveRef(root, schema.$ref)
        } catch {
            return value
        }
        return stripAddedNulls(value, target, root, depth + 1)
    }
    const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined
    if (Array.isArray(variants)) {
        for (const variant of variants) {
            const candidate = stripAddedNulls(value, variant, root, depth + 1)
            const ctx: Context = {
                root,
                errors: [],
                depth: 0,
            }
            check(candidate, variant, '', ctx)
            if (ctx.errors.length === 0) return candidate
        }
        return value
    }
    if (Array.isArray(value)) {
        const prefix = Array.isArray(schema.prefixItems) ? (schema.prefixItems as JsonSchema[]) : []
        return value.map((item, index) => {
            const itemSchema = index < prefix.length ? prefix[index] : (schema.items as JsonSchema | undefined)
            return itemSchema === undefined ? item : stripAddedNulls(item, itemSchema, root, depth + 1)
        })
    }
    if (isObject(value) && isObject(schema.properties)) {
        const properties = schema.properties as Record<string, JsonSchema>
        const required = new Set((schema.required ?? []) as string[])
        const out: SchemaObject = {}
        for (const [key, item] of Object.entries(value)) {
            const property = Object.hasOwn(properties, key) ? properties[key] : undefined
            if (property === undefined) {
                out[key] = item
                continue
            }
            const resolved =
                typeof property !== 'boolean' && typeof property.$ref === 'string'
                    ? safeResolve(root, property.$ref)
                    : property
            if (item === null && !required.has(key) && !acceptsNull(resolved)) continue
            out[key] = stripAddedNulls(item, property, root, depth + 1)
        }
        return out
    }
    return value
}

function safeResolve(root: JsonSchema, ref: string): JsonSchema | undefined {
    try {
        return resolveRef(root, ref)
    } catch {
        return undefined
    }
}

/* ---------- Claude Code and MiniMax ---------- */

/** The schema without `$schema` (tool input schemas, MiniMax). */
export function withoutMeta(schema: SchemaObject): SchemaObject {
    const strip = (node: unknown): unknown =>
        Array.isArray(node)
            ? node.map(strip)
            : isObject(node)
              ? Object.fromEntries(
                    Object.entries(node)
                        .filter(([key]) => key !== '$schema')
                        .map(([key, value]) => [
                            key,
                            strip(value),
                        ]),
                )
              : node
    return strip(schema) as SchemaObject
}

/**
 * Draft 7 for `claude --json-schema`, as Work Finder sends it
 * (z.toJSONSchema target draft-7): `$defs` → `definitions`, `prefixItems` →
 * `items` list.
 */
export function toDraft7(schema: SchemaObject): SchemaObject {
    const convert = (node: unknown, isRoot: boolean): unknown => {
        if (Array.isArray(node)) return node.map(item => convert(item, false))
        if (!isObject(node)) return node
        const out: SchemaObject = {}
        for (const [key, value] of Object.entries(node)) {
            if (key === '$schema') continue
            if (key === '$ref' && typeof value === 'string') out.$ref = value.replace(/^#\/\$defs\//, '#/definitions/')
            else if (key === '$defs' || key === 'definitions' || key === 'properties')
                out[key === '$defs' ? 'definitions' : key] = Object.fromEntries(
                    Object.entries(value as SchemaObject).map(([name, child]) => [
                        name,
                        convert(child, false),
                    ]),
                )
            else if (key === 'prefixItems') {
                out.items = convert(value, false)
                if (node.items === false) out.additionalItems = false
                else if (node.items !== undefined) out.additionalItems = convert(node.items, false)
            } else if (key === 'items' && 'prefixItems' in node) continue
            else if (
                [
                    'items',
                    'additionalProperties',
                    'propertyNames',
                    'not',
                    'contains',
                ].includes(key)
            )
                out[key] = convert(value, false)
            else if (
                [
                    'anyOf',
                    'oneOf',
                    'allOf',
                ].includes(key)
            )
                out[key] = convert(value, false)
            else out[key] = value
        }
        return isRoot
            ? {
                  $schema: 'http://json-schema.org/draft-07/schema#',
                  ...out,
              }
            : out
    }
    return convert(schema, true) as SchemaObject
}

import { wireSchemas } from './wire-schema.ts'
import type { BootstrapPage, ChangesPage } from '../api/types.ts'

export class SyncSchemaError extends Error {
  constructor() { super('Получен неподдерживаемый формат данных. Обновите приложение; черновики и отправка сохранены. Синхронизация остановлена.') }
}
type Schema = { $ref?: string; type?: string; const?: unknown; enum?: unknown[]; oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[]; if?: Schema; then?: Schema; else?: Schema; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; minItems?: number; maxItems?: number; uniqueItems?: boolean; minLength?: number; maxLength?: number; pattern?: string; format?: string; minimum?: number; maximum?: number }
function matches(value: unknown, schema: Schema): boolean {
  if (schema.$ref && !matches(value, wireSchemas[schema.$ref.split('/').at(-1)!] as Schema)) return false
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (schema.oneOf && schema.oneOf.filter(branch => matches(value, branch)).length !== 1) return false
  if (schema.anyOf && !schema.anyOf.some(branch => matches(value, branch))) return false
  if (schema.allOf && !schema.allOf.every(branch => matches(value, branch))) return false
  if (schema.if) { const branch = matches(value, schema.if) ? schema.then : schema.else; if (branch && !matches(value, branch)) return false }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false
  if (!schema.type && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (!(schema.required ?? []).every(key => Object.hasOwn(record, key)) || !Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(record, key) || matches(record[key], child))) return false
  }
  switch (schema.type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'integer': case 'number': return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum) && (schema.format !== 'int32' || (value >= -2147483648 && value <= 2147483647))
    case 'string': {
      if (typeof value !== 'string') return false
      const length = Array.from(value).length
      if ((schema.minLength !== undefined && length < schema.minLength) || (schema.maxLength !== undefined && length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))) return false
      if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false
      if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) return false
      if (schema.format === 'date-time' && (!Number.isFinite(Date.parse(value)) || value.startsWith('0000') || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))) return false
      return true
    }
    case 'array': return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && (!schema.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length) && (!schema.items || value.every(item => matches(item, schema.items!)))
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return (schema.required ?? []).every(key => Object.hasOwn(record, key)) && Object.entries(record).every(([key, field]) => Object.hasOwn(schema.properties ?? {}, key) ? matches(field, schema.properties![key]!) : schema.additionalProperties !== false)
    }
    default: return true
  }
}
export function validateWire<T>(value: unknown, name: string): T {
  try { if (!matches(value, wireSchemas[name] as Schema)) throw new SyncSchemaError() } catch { throw new SyncSchemaError() }
  return value as T
}
// UUID references in existing C1 JSON may preserve input case, while entity ids
// are canonical lowercase. Normalize received copies, never frozen requests or
// opaque entity versions/cursors.
export function normalizeReceived<T>(value: T): T {
  const ids = new Set(['id', 'categoryId', 'placeId', 'occurrenceId', 'definitionId', 'streamId', 'snapshotId', 'opId'])
  function normalize(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(normalize)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, field]) => [key, ids.has(key) && typeof field === 'string' ? field.toLowerCase() : normalize(field)]))
    return node
  }
  return normalize(value) as T
}
export const bootstrapPage = (value: unknown) => normalizeReceived(validateWire<BootstrapPage>(value, 'BootstrapPage'))
export const changesPage = (value: unknown) => normalizeReceived(validateWire<ChangesPage>(value, 'ChangesPage'))

import type { DraftRecord } from '../persistence/database.ts'
// DTO objects may be serialized in another property order by JSONB. Arrays and
// opaque versions retain their exact meaning and order.
export function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameData(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]))
}
// Fresh s3 reads add explicit U1 context to historical entities without changing
// their version. Compare only an editable copy; never rewrite stored pending.
export function editableBase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(editableBase)
  if (!value || typeof value !== 'object') return value
  const record = Object.fromEntries(Object.entries(value).map(([key, field]) => [key, editableBase(field)]))
  if (Object.hasOwn(record, 'durationPolicy') && Object.hasOwn(record, 'availabilityRules') && !Object.hasOwn(record, 'workOrigin')) record.workOrigin = 'manual'
  if (Object.hasOwn(record, 'sourceDefinitionVersion') && Object.hasOwn(record, 'constraintsSnapshot')) {
    if (!Object.hasOwn(record, 'timeIntent')) record.timeIntent = null
    if (!Object.hasOwn(record, 'resolvedTiming')) record.resolvedTiming = null
    if (!Object.hasOwn(record, 'placementIssue')) record.placementIssue = null
  }
  if (record.pattern === 'weekly' && Object.hasOwn(record, 'generatedThrough') && !Object.hasOwn(record, 'timeIntent')) record.timeIntent = null
  return record
}
export interface RestorationSelection { record: DraftRecord; editorKey: string }
export function selectRestoration(record: DraftRecord, editorKey: string = crypto.randomUUID()): RestorationSelection {
  return { record: structuredClone(record), editorKey }
}
export function openEditorDraft(userId: string, key: string, value: unknown, base: unknown, restored?: DraftRecord | null, draftId: string = crypto.randomUUID()): DraftRecord {
  return restored?.userId === userId && restored.key === key
    ? restored.category === 'emergency'
      ? { ...structuredClone(restored), category: 'manual', draftId: restored.sourceDraftId ?? restored.draftId, revision: restored.expectedRevision ?? 0, pendingOpId: undefined, sourceDraftId: undefined }
      : structuredClone(restored)
    : { userId, key, draftId, category: 'manual', value: structuredClone(value), base: structuredClone(base), revision: 0, editRevision: 0, updatedAt: Date.now() }
}
export function sameDraftRevision(current: DraftRecord | undefined, submitted: DraftRecord) { return current?.draftId === submitted.draftId && current.revision === submitted.revision && current.editRevision === submitted.editRevision && current.userId === submitted.userId }
// Only an acknowledged, unchanged editor can finish against a fresh base.
// A quiet pull never calls this function; changed local input keeps its baseline.
export function finishDraft<Value, Base>(current: DraftRecord, submitted: DraftRecord, value: Value, base: Base): DraftRecord {
  return sameDraftRevision(current, submitted) ? { ...current, value: structuredClone(value), base: structuredClone(base), revision: current.revision + 1, updatedAt: Date.now() } : current
}

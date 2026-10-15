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
export interface RestorationSelection { record: DraftRecord; editorKey: string }
export function selectRestoration(record: DraftRecord, editorKey: string = crypto.randomUUID()): RestorationSelection {
  return { record: structuredClone(record), editorKey }
}
export function openEditorDraft(userId: string, key: string, value: unknown, base: unknown, restored?: DraftRecord | null, draftId: string = crypto.randomUUID()): DraftRecord {
  return restored?.userId === userId && restored.key === key
    ? { ...structuredClone(restored), draftId, revision: 1, updatedAt: Date.now() }
    : { userId, key, draftId, value: structuredClone(value), base: structuredClone(base), revision: 1, updatedAt: Date.now() }
}
export function sameDraftRevision(current: DraftRecord | undefined, submitted: DraftRecord) { return current?.draftId === submitted.draftId && current.revision === submitted.revision && current.userId === submitted.userId }
// Only an acknowledged, unchanged editor can finish against a fresh base.
// A quiet pull never calls this function; changed local input keeps its baseline.
export function finishDraft<Value, Base>(current: DraftRecord, submitted: DraftRecord, value: Value, base: Base): DraftRecord {
  return sameDraftRevision(current, submitted) ? { ...current, value: structuredClone(value), base: structuredClone(base), revision: current.revision + 1, updatedAt: Date.now() } : current
}

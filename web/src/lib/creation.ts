import type { DraftRecord } from '../persistence/database.ts'
import type { Projection } from '../sync/projection.ts'
import { addDays, resolveLocalTime } from './time.ts'

export interface CreationStart { localStart: string; timezone: string; utcOffset: string }
export interface CreationIntent { definitionId: string; occurrenceId: string; logicalDate: string; start: CreationStart | null }
export function resolvedCreationStart(start: CreationStart): CreationStart { return { ...start, utcOffset: resolveLocalTime(`${start.localStart}:00`, start.timezone, start.utcOffset).utcOffset } }
export function isCreationRecord(record: DraftRecord | null | undefined): record is DraftRecord & { value: CreationIntent } {
  const value = record?.value as CreationIntent | undefined
  return !!record?.key.startsWith('calendar-create:') && !!value && typeof value.definitionId === 'string' && typeof value.occurrenceId === 'string' && typeof value.logicalDate === 'string'
}
export function prepareCreation(userId: string, definitionId: string, logicalDate: string, existing?: DraftRecord, start?: CreationStart | null): DraftRecord & { value: CreationIntent } {
  addDays(logicalDate, 0)
  const chosenStart = start === undefined && isCreationRecord(existing) ? existing.value.start ?? null : start ? resolvedCreationStart(start) : null
  if (chosenStart && chosenStart.localStart.slice(0, 10) !== logicalDate) throw new Error('Дата выполнения должна совпадать с выбранной датой начала.')
  if (isCreationRecord(existing)) {
    if (existing.userId !== userId || existing.value.definitionId !== definitionId) throw new Error('Продолжение относится к другой задаче или аккаунту.')
    return { ...existing, category: 'continuation', expectedRevision: existing.revision, value: { ...existing.value, logicalDate, start: chosenStart }, revision: existing.revision + 1, updatedAt: Date.now() }
  }
  return { userId, draftId: crypto.randomUUID(), category: 'continuation', expectedRevision: null, key: `calendar-create:${definitionId}`, value: { definitionId, occurrenceId: crypto.randomUUID(), logicalDate, start: chosenStart }, base: null, revision: 1, updatedAt: Date.now() }
}
export function creationStage(projection: Projection, intent: CreationIntent) {
  const occurrence = projection.occurrences.get(intent.occurrenceId.toLowerCase())
  if (occurrence) return occurrence.completionStatus === 'completed' ? 'completed' : occurrence.calendarBlock ? 'placed' : 'time'
  return projection.definitions.has(intent.definitionId.toLowerCase()) ? 'occurrence' : 'definition'
}
// A start draft belongs to an existing continuation, never to an occurrence
// guessed from its key. Its saved base must identify the same workflow.
export function creationStartContinuation(userId: string, draft: DraftRecord, records: DraftRecord[], projection: Projection) {
  if (draft.userId !== userId || !draft.key.startsWith('creation-start:')) return undefined
  const definitionId = draft.key.slice('creation-start:'.length).toLowerCase()
  const base = draft.base as Partial<CreationIntent> | null
  if (!base || typeof base.definitionId !== 'string' || typeof base.occurrenceId !== 'string' || base.definitionId.toLowerCase() !== definitionId || !projection.definitions.has(definitionId)) return undefined
  const occurrence = projection.occurrences.get(base.occurrenceId.toLowerCase())
  if (occurrence && occurrence.definitionId.toLowerCase() !== definitionId) return undefined
  return records.filter((record): record is DraftRecord & { value: CreationIntent } => record.userId === userId && isCreationRecord(record) && record.value.definitionId.toLowerCase() === definitionId && record.value.occurrenceId.toLowerCase() === base.occurrenceId!.toLowerCase() && record.key.toLowerCase() === `calendar-create:${definitionId}`).sort((a, b) => b.revision - a.revision)[0]
}
export function creationStartEditorState(record: DraftRecord & { value: CreationIntent }, editing: boolean, pending: boolean, readOnly = false) {
  return { visible: !record.value.start || editing, key: record.draftId, disabled: pending || readOnly }
}

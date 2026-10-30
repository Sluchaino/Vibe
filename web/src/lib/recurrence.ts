import type { DayOfWeek, RecurrenceRule, TaskDefinition } from '../api/types.ts'
import type { DraftRecord } from '../persistence/database.ts'
import { recurrenceForDefinition, type Projection } from '../sync/projection.ts'
import { addDays, isTimezone } from './time.ts'
import type { Command } from './operations.ts'

export const recurrenceDays: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
export interface RecurrenceDraft { id: string; daysOfWeek: DayOfWeek[]; timezone: string; startDate: string; endDate: string }
export interface RecurringIntent { definitionId: string; schedule: RecurrenceDraft }
export type RecurringRecord = DraftRecord & { value: RecurringIntent }
export function defaultRecurrence(timezone: string, date: string): RecurrenceDraft { return { id: crypto.randomUUID(), daysOfWeek: recurrenceDays.slice(0, 5), timezone, startDate: date, endDate: '' } }
export function recurrenceInput(value: RecurrenceDraft) {
  if (!isTimezone(value.timezone)) throw new Error('Укажите действительную IANA-зону повторения.')
  if (value.startDate.startsWith('0000') || (value.endDate && value.endDate.startsWith('0000'))) throw new Error('Выберите дату в пределах 0001–9999.')
  try { addDays(value.startDate, 0); if (value.endDate) addDays(value.endDate, 0) } catch { throw new Error('Укажите действительные даты повторения.') }
  if (value.endDate && value.endDate < value.startDate) throw new Error('Окончание повторения должно быть не раньше начала.')
  if (!value.daysOfWeek.length || new Set(value.daysOfWeek).size !== value.daysOfWeek.length || value.daysOfWeek.some(day => !recurrenceDays.includes(day))) throw new Error('Выберите хотя бы один день недели без повторов.')
  return { id: value.id, pattern: 'weekly' as const, daysOfWeek: recurrenceDays.filter(day => value.daysOfWeek.includes(day)), timezone: value.timezone, startDate: value.startDate, endDate: value.endDate || null }
}
export function createRecurrenceCommand(definition: TaskDefinition, value: RecurrenceDraft): Command { return { method: 'POST', path: `/task-definitions/${definition.id}/recurrence-rule`, body: { ...recurrenceInput(value), definitionVersion: definition.serverVersion } } }
export function stopRecurrenceCommand(rule: RecurrenceRule): Command { return { method: 'POST', path: `/recurrence-rules/${rule.id}/stop`, version: rule.serverVersion, body: {} } }
export function isRecurringRecord(record: DraftRecord | null | undefined): record is RecurringRecord {
  const value = record?.value as Partial<RecurringIntent> | undefined
  return !!record?.key.startsWith('recurring-create:') && typeof value?.definitionId === 'string' && !!value.schedule && typeof value.schedule.id === 'string'
}
export function prepareRecurring(userId: string, definitionId: string, schedule: RecurrenceDraft, previous?: RecurringRecord): RecurringRecord {
  recurrenceInput(schedule)
  if (previous && (previous.userId !== userId || previous.value.definitionId !== definitionId || previous.value.schedule.id !== schedule.id)) throw new Error('Продолжение относится к другой задаче или правилу.')
  return { userId, draftId: previous?.draftId ?? crypto.randomUUID(), category: 'continuation', key: `recurring-create:${definitionId}`, value: { definitionId, schedule: structuredClone(schedule) }, base: null, revision: (previous?.revision ?? 0) + 1, expectedRevision: previous?.revision ?? null, updatedAt: Date.now() }
}
export function recurringStage(projection: Projection, intent: RecurringIntent) { return recurrenceForDefinition(projection, intent.definitionId) ? 'rule' : projection.definitions.has(intent.definitionId.toLowerCase()) ? 'createRule' : 'definition' }
export function recurringRestoration(userId: string, selected: DraftRecord, records: DraftRecord[], projection: Projection) {
  if (selected.userId !== userId) return undefined
  if (isRecurringRecord(selected)) return selected
  if (selected.key === 'new-recurring-definition') { const id = (selected.value as { id?: string }).id; return records.find((row): row is RecurringRecord => row.userId === userId && isRecurringRecord(row) && row.value.definitionId === id) }
  if (!selected.key.startsWith('create-recurrence:')) return undefined
  const id = selected.key.slice('create-recurrence:'.length).toLowerCase(), base = selected.base as TaskDefinition | null, value = selected.value as RecurrenceDraft
  if (!base || base.id.toLowerCase() !== id || !projection.definitions.has(id)) return undefined
  return records.find((row): row is RecurringRecord => row.userId === userId && isRecurringRecord(row) && row.value.definitionId.toLowerCase() === id && row.value.schedule.id === value.id)
}
export function recurringRestoreKey(key: string) { return key === 'new-recurring-definition' || key.startsWith('recurring-create:') || key.startsWith('create-recurrence:') }
export function recurrenceStopRestoration(userId: string, draft: DraftRecord, projection: Projection) {
  if (draft.userId !== userId || !draft.key.startsWith('recurrence-stop:')) return undefined
  const rule = projection.recurrences.get(draft.key.slice('recurrence-stop:'.length).toLowerCase())
  const definition = rule && projection.definitions.get(rule.definitionId)
  return rule && definition ? { rule, definition } : undefined
}

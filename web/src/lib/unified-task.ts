import type { DefinitionFields, TimeIntent, DayOfWeek } from '../api/types.ts'
import type { DraftRecord } from '../persistence/database.ts'
import type { AccountRuntime } from '../sync/runtime.ts'
import type { Projection } from '../sync/projection.ts'
import { sameData } from './durable-draft.ts'
import { recurrenceDays } from './recurrence.ts'
import { isRecurringRecord } from './recurrence.ts'
import { isCreationRecord } from './creation.ts'
import { isTimezone } from './time.ts'
import { validDate } from './task-timing.ts'
import { emptyTiming, legacyTiming, timingDraft, type TimingDraft } from './task-timing.ts'
import type { ConstraintsDraft } from '../components/ConstraintsForm.tsx'

export type RepeatPreset = 'none' | 'daily' | 'weekdays' | 'weekends' | 'selected' | 'interval'
export interface UnifiedSchedule { id: string; pattern: 'weekly' | 'interval'; daysOfWeek: DayOfWeek[]; intervalDays: string; timezone: string; startDate: string; endDate: string }
export interface UnifiedIntent { definitionId: string; occurrenceId: string; definition: DefinitionFields; logicalDate: string | null; timeIntent: TimeIntent | null; schedule: UnifiedSchedule | null; definitionVersion: string | null }
export interface UnifiedDraft extends ConstraintsDraft { id: string; occurrenceId: string; ruleId: string; title: string; description: string; categoryId: string; importance: DefinitionFields['importance']; difficulty: DefinitionFields['difficulty']; executionPriority: string; timing: TimingDraft; timeRangeRaw?: string; repeat: RepeatPreset; daysOfWeek: DayOfWeek[]; intervalDays: string; anchorDate: string; endDate: string }
export function freshUnifiedDraft(timezone: string, placeId: string, shownAnchor: string): UnifiedDraft {
  return { id: crypto.randomUUID(), occurrenceId: crypto.randomUUID(), ruleId: crypto.randomUUID(), title: '', description: '', categoryId: '', importance: 'normal', difficulty: 'medium', executionPriority: '3', minutes: '', workOrigin: 'unspecified', mobilityPolicy: 'movable', availabilityRules: { timezone, windows: [], dateExceptions: [] }, placeId, timing: emptyTiming(timezone), repeat: 'none', daysOfWeek: [], intervalDays: '1', anchorDate: shownAnchor, endDate: '' }
}
export function adaptUnifiedDraft(value: unknown, timezone: string, placeId: string, shownAnchor: string): UnifiedDraft {
  const old = structuredClone(value) as Partial<UnifiedDraft> & { recurrence?: { id: string; startDate: string; endDate: string; timezone: string; daysOfWeek: DayOfWeek[] }; firstLocalStart?: string; firstOccurrenceDate?: string; firstTimezone?: string; firstUtcOffset?: string }
  if (old.timing) return old as UnifiedDraft
  const fresh = freshUnifiedDraft(timezone, placeId, shownAnchor), recurrence = old.recurrence
  const timing = legacyTiming(old, timezone)
  return { ...fresh, ...old, minutes: old.minutes ?? '', workOrigin: old.minutes ? 'manual' : old.workOrigin ?? 'unspecified', timing: { ...timing, ...(recurrence ? { logicalDate: timing.logicalDate || recurrence.startDate, timezone: old.firstLocalStart ? timing.timezone : recurrence.timezone } : {}) }, repeat: recurrence ? 'selected' : 'none', ruleId: recurrence?.id ?? fresh.ruleId, daysOfWeek: recurrence?.daysOfWeek ?? [], endDate: recurrence?.endDate ?? '', anchorDate: recurrence?.startDate || shownAnchor }
}
export function legacyInitialRoute(selected: DraftRecord | null, records: DraftRecord[], projection: Projection | null): 'oneOff' | 'recurring' | null {
  const id = (selected?.value as { id?: string } | undefined)?.id
  if (!selected || !id || !projection?.definitions.has(id.toLowerCase())) return null
  if (selected.key === 'new-definition' && records.some(row => row.userId === selected.userId && isCreationRecord(row) && row.value.definitionId.toLowerCase() === id.toLowerCase())) return 'oneOff'
  if (selected.key === 'new-recurring-definition' && records.some(row => row.userId === selected.userId && isRecurringRecord(row) && row.value.definitionId.toLowerCase() === id.toLowerCase())) return 'recurring'
  return null
}
export function editableLegacyContinuation(selected: DraftRecord | null, records: DraftRecord[], projection: Projection | null): DraftRecord | null {
  if (!selected || (!isCreationRecord(selected) && !isRecurringRecord(selected))) return null
  const id = selected.value.definitionId
  if (projection?.definitions.has(id.toLowerCase())) return null
  const sources = records.filter(row => row.userId === selected.userId && ['new-definition', 'new-recurring-definition', 'new-task'].includes(row.key) && (row.value as { id?: string })?.id?.toLowerCase() === id.toLowerCase())
  const saved = sources.filter(row => row.category !== 'emergency').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? sources.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (saved) return structuredClone(saved)
  // The continuation contains identities/time, not definition metadata. Make a
  // separate unsaved editor when its source was never explicitly saved; never
  // overwrite the independent continuation or invent work/title.
  const value = isCreationRecord(selected)
    ? { id, firstOccurrenceDate: selected.value.logicalDate, ...(selected.value.start ? { firstLocalStart: selected.value.start.localStart, firstTimezone: selected.value.start.timezone, firstUtcOffset: selected.value.start.utcOffset } : {}) }
    : { id, recurrence: structuredClone(selected.value.schedule) }
  return { userId: selected.userId, key: 'new-task', draftId: crypto.randomUUID(), category: 'manual', value, base: null, revision: 0, expectedRevision: null, updatedAt: selected.updatedAt }
}
export function creationEditorSelection(selected: DraftRecord | null, records: DraftRecord[], projection: Projection | null) {
  const restore = editableLegacyContinuation(selected, records, projection) ?? selected
  const legacy = legacyInitialRoute(restore, records, projection)
  const route = legacy === 'oneOff' || restore?.key.startsWith('calendar-create:') || restore?.key.startsWith('creation-start:') ? 'oneOff'
    : legacy === 'recurring' || restore?.key.startsWith('recurring-create:') || restore?.key.startsWith('create-recurrence:') ? 'recurring' : 'unified'
  return Object.freeze({ restore, route })
}
export function adaptRestoredUnified(selected: DraftRecord, records: DraftRecord[], timezone: string, placeId: string, shownAnchor: string): DraftRecord {
  const original = selected.value as Partial<UnifiedDraft> & { firstLocalStart?: string; firstTimezone?: string; firstUtcOffset?: string; firstOccurrenceDate?: string; recurrence?: unknown }
  const source = structuredClone(original)
  const id = source.id?.toLowerCase()
  const calendar = id && records.find(row => row.userId === selected.userId && isCreationRecord(row) && row.value.definitionId.toLowerCase() === id)
  const recurring = id && records.find(row => row.userId === selected.userId && isRecurringRecord(row) && row.value.definitionId.toLowerCase() === id)
  if (!source.timing && calendar && isCreationRecord(calendar)) {
    if (!Object.hasOwn(source, 'firstOccurrenceDate')) source.firstOccurrenceDate = calendar.value.logicalDate
    if (!Object.hasOwn(source, 'firstLocalStart') && calendar.value.start) {
      source.firstLocalStart = calendar.value.start.localStart
      source.firstTimezone = calendar.value.start.timezone
      source.firstUtcOffset = calendar.value.start.utcOffset
    }
  }
  if (!source.timing && !source.recurrence && recurring && isRecurringRecord(recurring)) source.recurrence = recurring.value.schedule
  const converted = adaptUnifiedDraft(source, timezone, placeId, shownAnchor)
  const unified = records.find((row): row is UnifiedRecord => row.userId === selected.userId && isUnifiedRecord(row) && row.value.definitionId.toLowerCase() === id)
  return { ...structuredClone(selected), value: { ...converted, occurrenceId: unified?.value.occurrenceId ?? (calendar && isCreationRecord(calendar) ? calendar.value.occurrenceId : converted.occurrenceId), ruleId: unified?.value.schedule?.id ?? (recurring && isRecurringRecord(recurring) ? recurring.value.schedule.id : converted.ruleId) } }
}
export function draftFromUnifiedIntent(intent: UnifiedIntent, shownAnchor: string): UnifiedDraft {
  const fields = intent.definition, schedule = intent.schedule
  return { ...freshUnifiedDraft(intent.timeIntent?.timezone ?? schedule?.timezone ?? fields.availabilityRules.timezone, fields.placeId, shownAnchor), ...fields, id: intent.definitionId, occurrenceId: intent.occurrenceId, ruleId: schedule?.id ?? crypto.randomUUID(), categoryId: fields.categoryId ?? '', executionPriority: String(fields.executionPriority), minutes: fields.workOrigin === 'manual' ? String(fields.durationPolicy!.requiredWorkMinutes) : '', timing: timingDraft(intent.logicalDate ?? schedule?.startDate ?? null, intent.timeIntent, schedule?.timezone ?? fields.availabilityRules.timezone), repeat: schedule ? schedule.pattern === 'interval' ? 'interval' : 'selected' : 'none', daysOfWeek: schedule?.daysOfWeek ?? [], intervalDays: schedule?.intervalDays ?? '1', anchorDate: schedule?.startDate ?? shownAnchor, endDate: schedule?.endDate ?? '' }
}
export type UnifiedRecord = DraftRecord & { value: UnifiedIntent }
export function isUnifiedRecord(record: DraftRecord | null | undefined): record is UnifiedRecord {
  const value = record?.value as Partial<UnifiedIntent> | undefined
  return typeof value?.definitionId === 'string' && record?.key.toLowerCase() === `task-create:${value.definitionId.toLowerCase()}` && typeof value.occurrenceId === 'string' && !!value.definition
}
export function unifiedStage(projection: Projection, intent: UnifiedIntent) {
  if (!projection.definitions.has(intent.definitionId.toLowerCase())) return 'definition'
  if (intent.schedule) {
    const rule = projection.recurrences.get(intent.schedule.id.toLowerCase())
    return rule?.definitionId === intent.definitionId.toLowerCase() ? 'done' : 'rule'
  }
  const occurrence = projection.occurrences.get(intent.occurrenceId.toLowerCase())
  return occurrence?.definitionId === intent.definitionId.toLowerCase() ? 'done' : 'occurrence'
}
export function prepareUnified(userId: string, intent: UnifiedIntent, previous?: UnifiedRecord): UnifiedRecord {
  if (previous && (previous.userId !== userId || previous.value.definitionId !== intent.definitionId || previous.value.occurrenceId !== intent.occurrenceId)) throw new Error('Продолжение относится к другой задаче или аккаунту.')
  return { userId, key: `task-create:${intent.definitionId}`, draftId: previous?.draftId ?? crypto.randomUUID(), category: 'continuation', value: structuredClone(intent), base: null, revision: (previous?.revision ?? 0) + 1, expectedRevision: previous?.revision ?? null, updatedAt: Date.now() }
}
export function scheduleInput(schedule: UnifiedSchedule, timeIntent: TimeIntent | null) {
  if (!isTimezone(schedule.timezone)) throw new Error('Укажите действительную IANA-зону повторения.')
  validDate(schedule.startDate)
  if (schedule.endDate) { validDate(schedule.endDate); if (schedule.endDate < schedule.startDate) throw new Error('Окончание повторения должно быть не раньше начала.') }
  if (timeIntent && schedule.timezone !== timeIntent.timezone) throw new Error('Зоны повторения и выбранных часов должны совпадать.')
  const common = { id: schedule.id, timezone: schedule.timezone, startDate: schedule.startDate, endDate: schedule.endDate || null, timeIntent }
  if (schedule.pattern === 'interval') {
    if (!/^\d+$/.test(schedule.intervalDays) || Number(schedule.intervalDays) < 1 || Number(schedule.intervalDays) > 2147483647) throw new Error('Повторять через целое число дней от 1 до 2147483647.')
    return { ...common, pattern: 'interval' as const, intervalDays: Number(schedule.intervalDays), anchorDate: schedule.startDate }
  }
  if (!schedule.daysOfWeek.length || new Set(schedule.daysOfWeek).size !== schedule.daysOfWeek.length || schedule.daysOfWeek.some(day => !recurrenceDays.includes(day))) throw new Error('Выберите дни повторения.')
  return { ...common, pattern: 'weekly' as const, daysOfWeek: recurrenceDays.filter(day => schedule.daysOfWeek.includes(day)) }
}
export class CreationDefinitionChanged extends Error { constructor() { super('Описание уже сохранено, но его условия изменились. Сравните их перед продолжением; новая копия задачи не создаётся.') } }
export function continuationDefinitionMatches(projection: Projection, intent: UnifiedIntent) {
  const definition = projection.definitions.get(intent.definitionId.toLowerCase())
  if (!definition) return false
  const { id: _id, serverVersion: _version, ...fields } = definition
  return sameData(fields, intent.definition)
}
type CreationRuntime = Pick<AccountRuntime, 'userId' | 'current' | 'saveDraftAndWait' | 'submit' | 'coordinator'>
// No outbox: at most one request, then an authoritative ACK tail, then another
// durable intent transaction. A stopped workflow never schedules background POSTs.
export async function runUnifiedCreation(runtime: CreationRuntime, key: string, initial: UnifiedRecord, current: () => boolean, changed: (record: UnifiedRecord) => void): Promise<boolean> {
  let record = initial
  const active = () => runtime.current() && current()
  for (let step = 0; step < 2; step++) {
    if (!active()) return false
    const projection = runtime.coordinator.snapshot().projection
    if (!projection) throw new Error('Дождитесь свежего состояния.')
    const stage = unifiedStage(projection, record.value)
    if (stage === 'done') return true
    if (step) record = prepareUnified(runtime.userId, record.value, record)
    if (stage !== 'definition' && !record.value.definitionVersion) {
      if (!continuationDefinitionMatches(projection, record.value)) throw new CreationDefinitionChanged()
      record = { ...record, value: { ...record.value, definitionVersion: projection.definitions.get(record.value.definitionId.toLowerCase())!.serverVersion } }
    }
    await runtime.saveDraftAndWait(record)
    changed(record)
    if (!active()) return false
    const intent = record.value
    const command = stage === 'definition'
      ? { method: 'POST' as const, path: '/task-definitions', body: { id: intent.definitionId, ...intent.definition } }
      : { method: 'POST' as const, path: `/task-definitions/${intent.definitionId}/${stage === 'rule' ? 'recurrence-rule' : 'occurrences'}`, body: stage === 'rule' ? { ...scheduleInput(intent.schedule!, intent.timeIntent), definitionVersion: intent.definitionVersion } : { id: intent.occurrenceId, definitionVersion: intent.definitionVersion, logicalDate: intent.logicalDate, timeIntent: intent.timeIntent } }
    const result = await runtime.submit(key, command, { value: intent, base: stage === 'definition' ? null : projection.definitions.get(intent.definitionId.toLowerCase()) })
    if (!result.success || !active()) return false
  }
  const projection = runtime.coordinator.snapshot().projection
  return !!projection && unifiedStage(projection, record.value) === 'done'
}

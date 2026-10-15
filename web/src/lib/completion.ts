import type { CalendarBlock, CompletionStatus, TaskOccurrence } from '../api/types.ts'
import type { Command } from './operations.ts'

export type CompletionIntent = { action: 'complete'; completionId: null } | { action: 'reopen'; completionId: string }
export type CompletionFilter = 'all' | CompletionStatus
export function hasCurrentCompletion(occurrence: TaskOccurrence) {
  return (occurrence.completionStatus === 'incomplete' && occurrence.completion === null && occurrence.remainingWorkMinutes > 0)
    || (occurrence.completionStatus === 'completed' && occurrence.completion != null && occurrence.completion.revokedAt === null && occurrence.completion.occurrenceId === occurrence.id && occurrence.remainingWorkMinutes === 0)
}
export function isCompleted(occurrence: TaskOccurrence) { return occurrence.completionStatus === 'completed' || occurrence.completion != null }
export function assertOccurrenceEditable(occurrence: TaskOccurrence) {
  if (!hasCurrentCompletion(occurrence)) throw new Error('Статус выполнения требует обновления. Перечитайте данные перед изменением.')
  if (isCompleted(occurrence)) throw new Error('Выполнение отмечено завершённым. Сначала снимите отметку; затем можно изменить условия или размещение.')
}
export function completionIntent(occurrence: TaskOccurrence): CompletionIntent {
  if (!hasCurrentCompletion(occurrence)) throw new Error('Для завершения требуется актуальная запись выполнения. Обновите данные.')
  return occurrence.completion ? { action: 'reopen', completionId: occurrence.completion.id } : { action: 'complete', completionId: null }
}
export function completionCommand(base: TaskOccurrence, intent: CompletionIntent): Command {
  // The observed target is immutable. A fresh active id never replaces it here.
  return { method: 'POST', path: `/occurrences/${base.id}/completion${intent.action === 'reopen' ? '/reopen' : ''}`, version: base.serverVersion, body: intent.action === 'reopen' ? { completionId: intent.completionId } : {} }
}
export function calendarMinutes(block: CalendarBlock) { return (Date.parse(block.endInstant) - Date.parse(block.startInstant)) / 60_000 }
export function occurrenceListPath(filter: CompletionFilter = 'all', definitionId?: string, unplanned = false) {
  const query = new URLSearchParams()
  if (definitionId) query.set('definitionId', definitionId)
  if (unplanned) query.set('placementStatus', 'unplanned')
  if (filter !== 'all') query.set('completionStatus', filter)
  const suffix = query.toString()
  return `/occurrences${suffix ? `?${suffix}` : ''}`
}

import type { TaskOccurrence } from '../api/types.ts'
import type { CompletionFilter } from './completion.ts'
import type { Projection } from '../sync/projection.ts'
import { addDays, localParts, monday } from './time.ts'

export type TaskPeriod = 'today' | 'week' | 'month' | 'all' | 'custom' | 'undated'
export interface TaskDateRange { from: string | null; to: string | null }
export interface TaskDay { date: string; occurrences: TaskOccurrence[] }
export interface TaskSegment { kind: 'upcoming' | 'past' | 'chronological'; days: TaskDay[] }
export function taskToday(timezone: string, now: number = Date.now()) { return localParts(now, timezone).date }
export function taskDateRange(period: TaskPeriod, today: string, custom: { from: string; to: string }): TaskDateRange {
  addDays(today, 0)
  if (period === 'all' || period === 'undated') return { from: null, to: null }
  if (period === 'today') return { from: today, to: today }
  if (period === 'week') { const from = monday(today); return { from, to: addDays(from, 6) } }
  if (period === 'month') {
    const from = `${today.slice(0, 7)}-01`
    // Civil date arithmetic, independent of the length of any IANA day.
    const after = addDays(from, 31), nextMonth = `${after.slice(0, 7)}-01`
    return { from, to: addDays(nextMonth, -1) }
  }
  try { addDays(custom.from, 0); addDays(custom.to, 0) } catch { throw new Error('Укажите действительные даты начала и конца периода.') }
  if (custom.from > custom.to) throw new Error('Конец периода должен быть не раньше начала.')
  return { from: custom.from, to: custom.to }
}
export function selectTaskDays(projection: Projection, period: TaskPeriod, today: string, custom: { from: string; to: string }, completion: CompletionFilter = 'all'): TaskSegment[] {
  const range = taskDateRange(period, today, custom)
  const days = new Map<string, TaskOccurrence[]>()
  for (const occurrence of projection.occurrences.values()) {
    const date = occurrence.logicalDate
    if ((!date && period !== 'all' && period !== 'undated') || (date && period === 'undated') || (date && range.from && date < range.from) || (date && range.to && date > range.to) || (completion !== 'all' && occurrence.completionStatus !== completion)) continue
    const group = days.get(date ?? '') ?? []
    group.push(occurrence); days.set(date ?? '', group)
  }
  const ordered = [...days].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b)).map(([date, occurrences]) => ({ date, occurrences: [...occurrences].sort((a, b) => (a.calendarBlock?.startInstant ?? '').localeCompare(b.calendarBlock?.startInstant ?? '') || a.id.localeCompare(b.id)) }))
  return period === 'week' || period === 'month'
    ? [{ kind: 'upcoming', days: ordered.filter(day => day.date >= today) }, { kind: 'past', days: ordered.filter(day => day.date < today) }]
    : [{ kind: 'chronological', days: ordered }]
}
// A page is made of complete days. Each rolling segment has an independent
// limit, so a long future segment cannot hide the start of the past segment.
export function pageTaskDays(days: TaskDay[], count: number) { return { days: days.slice(0, Math.max(1, count)), hasMore: days.length > Math.max(1, count) } }

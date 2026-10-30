import type { DstDisambiguation, PlacementIssue, ResolvedTiming, TimeIntent, WorkOrigin } from '../api/types.ts'
import { addDays, isTimezone, localCandidates, toUtc } from './time.ts'

export interface TimingDraft {
  logicalDate: string; startTime: string; endTime: string; endDayOffset: string
  timezone: string; startDisambiguation: DstDisambiguation; endDisambiguation: DstDisambiguation
}
export function emptyTiming(timezone: string): TimingDraft {
  return { logicalDate: '', startTime: '', endTime: '', endDayOffset: '0', timezone, startDisambiguation: null, endDisambiguation: null }
}
export function timingDraft(logicalDate: string | null, intent: TimeIntent | null, timezone: string): TimingDraft {
  return { ...emptyTiming(intent?.timezone ?? timezone), logicalDate: logicalDate ?? '', startTime: intent?.startLocalTime ?? '', endTime: intent?.endLocalTime ?? '', endDayOffset: String(intent?.endDayOffset ?? 0), startDisambiguation: intent?.startDisambiguation ?? null, endDisambiguation: intent?.endDisambiguation ?? null }
}
export function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) throw new Error('Выберите действительную дату в пределах 0001–9999.')
  addDays(date, 0)
  return date
}
export function timeIntent(value: TimingDraft, date = value.logicalDate): TimeIntent | null {
  if (date) validDate(date)
  if (!value.startTime && !value.endTime) return null
  if (!date) throw new Error('Для выбранных часов укажите дату.')
  if (!isTimezone(value.timezone)) throw new Error('Укажите действительную IANA-зону времени.')
  for (const time of [value.startTime, value.endTime]) if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Укажите время с точностью до минуты.')
  const offset = value.endTime ? Number(value.endDayOffset) : 0
  if (value.endTime && !/^\d+$/.test(value.endDayOffset)) throw new Error('Укажите число дней до окончания: 0 — та же дата, 1 — следующий день.')
  if (!Number.isInteger(offset) || offset < 0 || offset > 3652058) throw new Error('Укажите неотрицательное число дней до окончания.')
  validDate(addDays(date, offset))
  return { timezone: value.timezone, startLocalTime: value.startTime || null, endLocalTime: value.endTime || null, endDayOffset: offset, startDisambiguation: value.startTime ? value.startDisambiguation : null, endDisambiguation: value.endTime ? value.endDisambiguation : null }
}
export function workOrigin(minutes: string, intent: TimeIntent | null): WorkOrigin {
  return minutes !== '' ? 'manual' : intent?.startLocalTime && intent.endLocalTime ? 'interval' : 'unspecified'
}
function boundary(date: string, time: string, timezone: string, preference: DstDisambiguation) {
  const candidates = localCandidates(`${date}T${time}:00`, timezone)
  if (!candidates.length) return { issue: 'invalidLocalTime' as const }
  if (candidates.length > 1 && !preference) return { issue: 'ambiguousLocalTime' as const }
  return { instant: (preference === 'later' ? candidates.at(-1)! : candidates[0]!).instant }
}
export function timingPreview(date: string | null, intent: TimeIntent | null, manualMinutes: number | null): { resolved: ResolvedTiming | null; minutes: number | null; issue: PlacementIssue | null } {
  const none = { resolved: null, minutes: manualMinutes, issue: null }
  if (!date || !intent || (!manualMinutes && !(intent.startLocalTime && intent.endLocalTime))) return none
  try {
    const start = intent.startLocalTime ? boundary(date, intent.startLocalTime, intent.timezone, intent.startDisambiguation) : null
    const end = intent.endLocalTime ? boundary(validDate(addDays(date, intent.endDayOffset)), intent.endLocalTime, intent.timezone, intent.endDisambiguation) : null
    if (start?.issue || end?.issue) return { ...none, issue: start?.issue ?? end!.issue! }
    const startInstant = start?.instant ?? toUtc(Date.parse(end!.instant!) - manualMinutes! * 60_000)
    const endInstant = end?.instant ?? toUtc(Date.parse(start!.instant!) + manualMinutes! * 60_000)
    if (startInstant.startsWith('0000') || endInstant.startsWith('0000')) return { ...none, issue: 'outOfRange' }
    for (const instant of [startInstant, endInstant]) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: intent.timezone, year: 'numeric', era: 'short' }).formatToParts(new Date(instant))
      const year = Number(parts.find(part => part.type === 'year')?.value)
      if (parts.find(part => part.type === 'era')?.value !== 'AD' || year < 1 || year > 9999) return { ...none, issue: 'outOfRange' }
    }
    const minutes = (Date.parse(endInstant) - Date.parse(startInstant)) / 60_000
    if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 2147483647 || (manualMinutes !== null && minutes !== manualMinutes)) return { ...none, issue: 'workMismatch' }
    return { resolved: { startInstant, endInstant }, minutes, issue: null }
  } catch { return { ...none, issue: 'outOfRange' } }
}
export const placementIssueLabels: Record<PlacementIssue, string> = {
  invalidLocalTime: 'Выбранное местное время не существует из-за перевода часов. Начало не сдвигается автоматически.',
  ambiguousLocalTime: 'Время встречается дважды. Выберите раннее или позднее вхождение, чтобы занять время в календаре.',
  workMismatch: 'Часы и полный объём не согласуются. Время не занято; проверьте условия выполнения.',
  placementConflict: 'Время уже занято другим выполнением. Намерение сохранено, блок не создан.',
  outsideAvailability: 'Не удалось подтвердить разрешённое окно для полного объёма. Время не занято.',
  outOfRange: 'Вычисленное время выходит за поддерживаемые границы. Время не занято.',
}
// Adapt only an editable UI copy. Historical frozen commands are never passed here.
export function legacyTiming(value: { firstLocalStart?: string; firstOccurrenceDate?: string; firstTimezone?: string; firstUtcOffset?: string }, timezone: string): TimingDraft {
  const local = value.firstLocalStart ?? ''
  const result = { ...emptyTiming(value.firstTimezone ?? timezone), logicalDate: local.slice(0, 10) || value.firstOccurrenceDate || '', startTime: local.slice(11, 16) }
  if (local && value.firstUtcOffset) {
    const candidates = localCandidates(`${local.slice(0,16)}:00`, result.timezone)
    const index = candidates.findIndex(item => item.utcOffset === value.firstUtcOffset)
    if (candidates.length > 1 && index >= 0) result.startDisambiguation = index === 0 ? 'earlier' : 'later'
  }
  return result
}

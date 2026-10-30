import type { TimingDraft } from './task-timing.ts'

type RangeDraft = { timing: TimingDraft; timeRangeRaw?: string }

// Legacy editable drafts are displayed without migrating or writing them on open.
export function timeRangeText(value: RangeDraft): string {
  if (value.timeRangeRaw !== undefined) return value.timeRangeRaw
  const { startTime, endTime } = value.timing
  return endTime ? `${startTime} - ${endTime}`.trimStart() : startTime
}

function hour(value: string) {
  if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Проверьте часы: допустимо время от 00:00 до 23:59.')
  return value.padStart(5, '0')
}

// Parse at validation/preview boundaries, never rewrite the controlled raw input.
export function parseTimeRange(raw: string): Pick<TimingDraft, 'startTime' | 'endTime'> {
  const value = raw.trim()
  if (!value) return { startTime: '', endTime: '' }
  const parts = value.split(/[-–—]/)
  if (parts.length === 1) return { startTime: hour(value), endTime: '' }
  if (parts.length !== 2) throw new Error('Укажите один интервал, например «10:00 - 11:30».')
  const start = parts[0]!.trim(), end = parts[1]!.trim()
  if (!end) throw new Error('Уточните конец интервала или уберите дефис, чтобы оставить только начало.')
  return { startTime: start ? hour(start) : '', endTime: hour(end) }
}

export function timingFromRange(value: RangeDraft): TimingDraft {
  return { ...value.timing, ...parseTimeRange(timeRangeText(value)) }
}

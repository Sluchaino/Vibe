import type { UnifiedDraft } from './unified-task.ts'

const dayLabels = { monday: 'Пн', tuesday: 'Вт', wednesday: 'Ср', thursday: 'Чт', friday: 'Пт', saturday: 'Сб', sunday: 'Вс' }
function dateLabel(date: string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}` : date }

export function taskTimeSummary(value: UnifiedDraft) {
  const time = value.timing, timing: string[] = [], conditions: string[] = []
  if (time.logicalDate) timing.push(dateLabel(time.logicalDate))
  if (time.startTime) timing.push(`начало ${time.startTime}`)
  if (time.endTime) {
    const day = time.endDayOffset === '0' ? '' : time.endDayOffset ? ` (+${time.endDayOffset} дн.)` : ' (день окончания не задан)'
    timing.push(`конец ${time.endTime}${day}`)
  }
  if (time.startTime || time.endTime) {
    if (!time.logicalDate && value.repeat === 'none') timing.unshift('Дата не задана')
    timing.push(time.timezone)
  }
  if (!timing.length) timing.push('Дата и время не заданы')
  if (value.repeat === 'none') conditions.push('Без повторения')
  else {
    const repeat = value.repeat === 'daily' ? 'Каждый день' : value.repeat === 'weekdays' ? 'Будни' : value.repeat === 'weekends' ? 'Выходные'
      : value.repeat === 'interval' ? `Через каждые ${value.intervalDays || '…'} дн.`
      : value.daysOfWeek.length ? value.daysOfWeek.map(day => dayLabels[day]).join(', ') : 'Дни повторения не выбраны'
    const anchor = time.logicalDate || value.anchorDate
    conditions.push(`${repeat}${anchor ? ` от ${dateLabel(anchor)}` : ''}${value.endDate ? ` по ${dateLabel(value.endDate)}` : ''}`)
  }
  if (value.minutes) conditions.push(`полный объём ${value.minutes} мин`)
  else if (time.startTime && time.endTime) conditions.push('объём по интервалу')
  if (value.mobilityPolicy === 'fixedAfterPlacement') conditions.push('закреплять время')
  if (value.availabilityRules.windows.length || value.availabilityRules.dateExceptions.length) conditions.push('окна заданы')
  return { timing: timing.join(' · '), conditions: conditions.join(' · ') }
}

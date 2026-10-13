import type { CalendarResponse, TaskOccurrence } from '../api/types'
import { effectiveFixed } from '../lib/operations'
import { addDays, dateLabel, instantLabel, intersects, startOfLocalDate } from '../lib/time'

export function Calendar({ data, dates, timezone, view, onOpen }: { data: CalendarResponse | null; dates: string[]; timezone: string; view: 'day' | 'week'; onOpen: (occurrence: TaskOccurrence) => void }) {
  return <div className={`calendar calendar--${view}`} tabIndex={view === 'week' ? 0 : undefined} aria-label={view === 'day' ? 'Календарь на день' : 'Календарь на неделю'}>{dates.map(date => {
    const from = startOfLocalDate(date, timezone)
    const to = startOfLocalDate(addDays(date, 1), timezone)
    const blocks = (data?.blocks ?? []).filter(block => intersects(block.startInstant, block.endInstant, from, to)).sort((a, b) => a.startInstant.localeCompare(b.startInstant))
    const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000
    return <section className="calendar-day" key={date} aria-label={dateLabel(date)}><div className="calendar-day__heading"><h3>{dateLabel(date, true)}</h3>{hours !== 24 && <small>{hours} ч · перевод часов</small>}</div>{blocks.length === 0 && <p className="calendar-empty">Нет запланированных выполнений</p>}{blocks.map(block => {
      const occurrence = data?.occurrences.find(item => item.id === block.occurrenceId)
      const definition = data?.definitions.find(item => item.id === occurrence?.definitionId)
      return <button type="button" className="calendar-event" key={block.id} onClick={() => occurrence && onOpen(occurrence)}><span className="event-time">{instantLabel(block.startInstant, timezone)}<br />— {instantLabel(block.endInstant, timezone)}</span><strong>{definition?.title ?? 'Выполнение'}</strong><span>{occurrence?.remainingWorkMinutes} мин · {occurrence && effectiveFixed(occurrence) ? 'закреплено' : 'можно перенести'}</span>{occurrence && occurrence.logicalDate !== date && <span>Метка выполнения: {occurrence.logicalDate}</span>}{block.startInstant < from && <span>Началось раньше этого дня</span>}{block.endInstant > to && <span>Продолжится на следующий день</span>}</button>
    })}</section>
  })}</div>
}

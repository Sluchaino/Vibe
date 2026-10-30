import { useEffect, useState, type ReactNode } from 'react'
import type { TaskOccurrence } from '../api/types'
import type { Projection } from '../sync/projection'
import type { CompletionFilter } from '../lib/completion'
import { pageTaskDays, selectTaskDays, taskDateRange, taskToday, type TaskPeriod, type TaskSegment } from '../lib/task-period'
import { dateLabel } from '../lib/time'
import { ErrorMessage, Field } from './shared'
import { useRuntime } from '../sync/context'

function useTaskToday(timezone: string) {
  const [observed, setObserved] = useState(() => ({ timezone, date: taskToday(timezone) }))
  useEffect(() => {
    const update = () => setObserved(previous => { const date = taskToday(timezone); return previous.timezone === timezone && previous.date === date ? previous : { timezone, date } })
    update()
    // Re-evaluate IANA civil date rather than adding 24h across DST. Focus also
    // catches midnight while this tab was asleep or the device clock changed.
    const timer = setInterval(update, 1000)
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [timezone])
  return observed.timezone === timezone ? observed.date : taskToday(timezone)
}
function TaskDayGroups({ segment, today, renderCard }: { segment: TaskSegment; today: string; renderCard: (item: TaskOccurrence) => ReactNode }) {
  const [count, setCount] = useState(7)
  const page = pageTaskDays(segment.days, count)
  if (!segment.days.length) return null
  return <section className={`task-segment task-segment--${segment.kind}`} aria-label={segment.kind === 'past' ? 'Прошедшие дни' : segment.kind === 'upcoming' ? 'Сегодня и ближайшие дни' : 'Задачи по датам'}>
    {segment.kind === 'past' && <h3 className="past-days-divider">Прошедшие дни</h3>}
    {page.days.map(day => <section className="task-day" key={day.date} aria-label={(day.date ? dateLabel(day.date) : 'Без даты')}><div className="task-day__heading"><h3>{(day.date ? dateLabel(day.date) : 'Без даты')}{day.date === today && <span className="today-badge">Сегодня</span>}</h3><span>{day.occurrences.length}</span></div><div className="card-list">{day.occurrences.map(renderCard)}</div></section>)}
    {page.hasMore && <button type="button" className="load-more" onClick={() => setCount(value => value + 7)}>{segment.kind === 'past' ? 'Показать ещё прошедшие дни' : 'Показать ещё дни'}</button>}
  </section>
}
export function TaskList({ projection, timezone, renderCard, onNew }: { projection: Projection; timezone: string; renderCard: (item: TaskOccurrence) => ReactNode; onNew: () => void }) {
  const { runtime } = useRuntime(), today = useTaskToday(timezone)
  const [period, setPeriod] = useState<TaskPeriod>('today')
  const [completion, setCompletion] = useState<CompletionFilter>('all')
  const [custom, setCustom] = useState(() => ({ from: today, to: today }))
  let segments: TaskSegment[] = [], error: Error | null = null, caption = period === 'undated' ? 'Без даты' : 'Все даты'
  try { const range = taskDateRange(period, today, custom); segments = selectTaskDays(projection, period, today, custom, completion); if (range.from && range.to) caption = range.from === range.to ? dateLabel(range.from) : `${dateLabel(range.from)} — ${dateLabel(range.to)}` } catch (failure) { error = failure as Error }
  const filterKey = `${period}:${period === 'custom' ? `${custom.from}:${custom.to}` : period === 'all' || period === 'undated' ? '' : today}:${completion}`
  const count = segments.reduce((total, segment) => total + segment.days.reduce((number, day) => number + day.occurrences.length, 0), 0)
  function change(action: () => void) { void runtime.requestLeave(action) }
  return <section className="panel task-list" aria-labelledby="task-list-heading"><div className="panel-heading"><div><h2 id="task-list-heading">Задачи</h2><p className="muted">Конкретные выполнения по выбранной дате. Отметка относится к одному выполнению.</p></div><button type="button" className="primary" disabled={!projection.settings?.place} onClick={onNew}>Новая задача</button></div>
    <div className="task-filters"><Field label="Период задач"><select value={period} onChange={event => { const value = event.target.value as TaskPeriod; change(() => setPeriod(value)) }}><option value="today">Сегодня</option><option value="week">Неделя</option><option value="month">Месяц</option><option value="all">Все</option><option value="undated">Без даты</option><option value="custom">Свой период</option></select></Field><Field label="Статус задач"><select value={completion} onChange={event => { const value = event.target.value as CompletionFilter; change(() => setCompletion(value)) }}><option value="all">Все статусы</option><option value="incomplete">Не выполненные</option><option value="completed">Выполненные</option></select></Field>{period === 'custom' && <><Field label="Начало периода" hint="Включительно"><input type="date" required value={custom.from} aria-invalid={!!error} aria-describedby={error ? 'task-period-error' : undefined} onChange={event => { const from = event.target.value; change(() => setCustom(value => ({ ...value, from }))) }} /></Field><Field label="Конец периода" hint="Включительно"><input type="date" required value={custom.to} aria-invalid={!!error} aria-describedby={error ? 'task-period-error' : undefined} onChange={event => { const to = event.target.value; change(() => setCustom(value => ({ ...value, to }))) }} /></Field></>}</div>
    <p className="task-period-caption" role="status">{caption} · {timezone}{!error && ` · задач: ${count}`}</p><div id="task-period-error"><ErrorMessage error={error} /></div>
    {!error && count === 0 && <p className="empty-state">{completion === 'all' ? 'Нет задач в выбранном периоде.' : 'Нет задач с выбранным статусом в этом периоде.'}</p>}
    {segments.map(segment => <TaskDayGroups key={`${filterKey}:${segment.kind}`} segment={segment} today={today} renderCard={renderCard} />)}
  </section>
}

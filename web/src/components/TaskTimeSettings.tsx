import type { Category, MobilityPolicy } from '../api/types'
import type { UnifiedDraft, RepeatPreset } from '../lib/unified-task'
import { recurrenceDays } from '../lib/recurrence'
import { placementIssueLabels, timeIntent, timingPreview, type TimingDraft } from '../lib/task-timing'
import { timeRangeText, timingFromRange } from '../lib/time-range'
import { addDays, instantLabel, localCandidates } from '../lib/time'
import { AvailabilityForm, weekdays } from './AvailabilityForm'
import { Field } from './shared'

export const advancedScreens = {
  metadata: 'Описание и характеристики',
  repeat: 'Повторение',
  clock: 'Часовой пояс и фиксация',
  availability: 'Когда можно выполнять',
}
export type SettingsScreen = keyof typeof advancedScreens
type Props = {
  value: UnifiedDraft
  onChange: (value: UnifiedDraft) => void
  placeName: string
  categories: Category[]
  readOnly: boolean
  screen: SettingsScreen
}

// Controlled fields only: every screen shares the parent's sole draft/session.
export function TaskTimeSettings({ value, onChange, placeName, categories, readOnly, screen }: Props) {
  function change(patch: Partial<UnifiedDraft>) { onChange({ ...value, ...patch }) }
  function repeat(next: RepeatPreset) {
    const days = next === 'daily' ? recurrenceDays : next === 'weekdays' ? recurrenceDays.slice(0, 5) : next === 'weekends' ? recurrenceDays.slice(5) : value.daysOfWeek
    change({ repeat: next, daysOfWeek: [...days] })
  }
  return <fieldset disabled={readOnly}>
    {screen === 'metadata' && <>
      <Field label="Описание (необязательно)">
        <textarea rows={3} value={value.description} onChange={event => change({ description: event.target.value })} />
      </Field>
      <div className="form-grid">
        <Field label="Категория">
          <select value={value.categoryId} onChange={event => change({ categoryId: event.target.value })}>
            <option value="">Без категории</option>
            {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </Field>
        <Field label="Важность">
          <select value={value.importance} onChange={event => change({ importance: event.target.value as UnifiedDraft['importance'] })}>
            <option value="low">Низкая</option><option value="normal">Обычная</option><option value="high">Высокая</option>
          </select>
        </Field>
        <Field label="Сложность">
          <select value={value.difficulty} onChange={event => change({ difficulty: event.target.value as UnifiedDraft['difficulty'] })}>
            <option value="light">Лёгкая</option><option value="medium">Средняя</option><option value="heavy">Тяжёлая</option>
          </select>
        </Field>
        <Field label="Приоритет">
          <select value={value.executionPriority} onChange={event => change({ executionPriority: event.target.value })}>
            {[1, 2, 3, 4, 5].map(priority => <option key={priority}>{priority}</option>)}
          </select>
        </Field>
      </div>
    </>}
    {screen === 'repeat' && <>
      <Field label="Повторение">
        <select value={value.repeat} onChange={event => repeat(event.target.value as RepeatPreset)}>
          <option value="none">Не повторять</option>
          <option value="daily">Каждый день</option>
          <option value="weekdays">Будни</option>
          <option value="weekends">Выходные</option>
          <option value="selected">Выбранные дни недели</option>
          <option value="interval">Через каждые N дней</option>
        </select>
      </Field>
      {value.repeat !== 'none' && <>
        {value.repeat === 'interval' ? <Field label="Через сколько дней">
          <input required type="number" min="1" max="2147483647" step="1" value={value.intervalDays} onChange={event => change({ intervalDays: event.target.value })} />
        </Field> : <div className="weekday-checks" role="group" aria-label="Дни повторения">
          {weekdays.map(day => <label key={day.value}>
            <input type="checkbox" checked={value.daysOfWeek.includes(day.value)} onChange={event => change({
              repeat: 'selected',
              daysOfWeek: event.target.checked ? [...value.daysOfWeek, day.value] : value.daysOfWeek.filter(item => item !== day.value),
            })} />
            {day.label}
          </label>)}
        </div>}
        {!value.timing.logicalDate && <Field label="Начальный день повторения" hint="Явная опорная дата; не сдвигается после простоя.">
          <input required type="date" value={value.anchorDate} onChange={event => change({ anchorDate: event.target.value })} />
        </Field>}
        <Field label="Конец повторения (необязательно)" hint="Включительно.">
          <input type="date" value={value.endDate} onChange={event => change({ endDate: event.target.value })} />
        </Field>
        <p className="muted">Сервер готовит даты на 31 день вперёд. Общие часы проверяются отдельно на каждой дате; отказ занять время будет показан у выполнения.</p>
      </>}
    </>}
    {screen === 'clock' && <>
      <ClockSettings value={value} onChange={onChange} />
      <Field label="Фиксация после размещения">
        <select value={value.mobilityPolicy} onChange={event => change({ mobilityPolicy: event.target.value as MobilityPolicy })}>
          <option value="movable">Можно переносить вручную</option>
          <option value="fixedAfterPlacement">Закрепить выбранное время</option>
        </select>
      </Field>
      <p className="muted">Место: <strong>{placeName}</strong>. Без дробления и обязательного отдыха.</p>
    </>}
    {screen === 'availability' && <AvailabilityForm value={value.availabilityRules} onChange={availabilityRules => change({ availabilityRules })} />}
  </fieldset>
}

function ClockSettings({ value, onChange }: Pick<Props, 'value' | 'onChange'>) {
  let timing: TimingDraft | null = null, preview: ReturnType<typeof timingPreview> | null = null, error = ''
  const selectedDate = value.timing.logicalDate || (value.repeat !== 'none' ? value.anchorDate : '')
  try {
    timing = timingFromRange(value)
    preview = timingPreview(selectedDate || null, timeIntent(timing, selectedDate), value.minutes ? Number(value.minutes) : null)
  } catch (failure) { error = (failure as Error).message }
  function change(patch: Partial<TimingDraft>) { onChange({ ...value, timing: { ...value.timing, ...patch } }) }
  function fold(end: boolean) {
    const time = end ? timing?.endTime : timing?.startTime
    if (!selectedDate || !time) return null
    try {
      const date = end ? addDays(selectedDate, Number(value.timing.endDayOffset)) : selectedDate
      const candidates = localCandidates(`${date}T${time}:00`, value.timing.timezone)
      if (candidates.length < 2) return null
      const key = end ? 'endDisambiguation' : 'startDisambiguation'
      return <Field label={end ? 'Конец при переводе часов' : 'Начало при переводе часов'} hint="Без выбора намерение сохранится, но время не будет занято.">
        <select value={value.timing[key] ?? ''} onChange={event => change({ [key]: event.target.value || null })}>
          <option value="">Вхождение не выбрано</option>
          <option value="earlier">Раннее · {candidates[0]!.utcOffset}</option>
          <option value="later">Позднее · {candidates.at(-1)!.utcOffset}</option>
        </select>
      </Field>
    } catch { return null }
  }
  return <>
    <p className="muted">Время: {timeRangeText(value) || 'не задано'}. Изменить дату и часы можно в основной форме.</p>
    <div className="form-grid">
      <Field label="Часовой пояс времени">
        <input required list="timezones" value={value.timing.timezone} onChange={event => change({ timezone: event.target.value })} />
      </Field>
      <Field label="Конец через дней" hint="0 — в выбранную дату, 1 — на следующий день. Применяется при заданном конце; ночь не подставляется автоматически.">
        <input type="number" min="0" max="3652058" step="1" value={value.timing.endDayOffset} onChange={event => change({ endDayOffset: event.target.value })} />
      </Field>
      {fold(false)}{fold(true)}
    </div>
    {error && <p className="notice" role="status">{error}</p>}
    {preview?.issue && <p className="notice" role="status">{placementIssueLabels[preview.issue]}</p>}
    {preview?.resolved && <div className="preview">
      <strong>Предполагаемое время</strong>
      <p>{instantLabel(preview.resolved.startInstant, value.timing.timezone)} — {instantLabel(preview.resolved.endInstant, value.timing.timezone)} · {preview.minutes} мин</p>
      <p>Сервер проверит полный объём, разрешённые окна и занятость. Это ещё не календарный блок.</p>
    </div>}
  </>
}

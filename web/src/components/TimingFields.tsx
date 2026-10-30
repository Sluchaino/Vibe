import type { TimingDraft } from '../lib/task-timing'
import { placementIssueLabels, timeIntent, timingPreview } from '../lib/task-timing'
import { addDays, instantLabel, localCandidates } from '../lib/time'
import { Field } from './shared'

export function TimingFields({ value, onChange, minutes, dateLabel = 'Дата (необязательно)', previewDate }: { value: TimingDraft; onChange: (value: TimingDraft) => void; minutes: string; dateLabel?: string; previewDate?: string }) {
  let preview: ReturnType<typeof timingPreview> | null = null, error = ''
  const selectedDate = value.logicalDate || previewDate || ''
  try { preview = timingPreview(selectedDate || null, timeIntent(value, selectedDate), minutes ? Number(minutes) : null) } catch (failure) { error = (failure as Error).message }
  function fold(end: boolean) {
    const time = end ? value.endTime : value.startTime
    if (!selectedDate || !time) return null
    try {
      const date = end ? addDays(selectedDate, Number(value.endDayOffset)) : selectedDate
      const candidates = localCandidates(`${date}T${time}:00`, value.timezone)
      if (candidates.length < 2) return null
      const key = end ? 'endDisambiguation' : 'startDisambiguation'
      return <Field label={end ? 'Конец при переводе часов' : 'Начало при переводе часов'} hint="Без выбора намерение сохранится, но время не будет занято."><select value={value[key] ?? ''} onChange={event => onChange({ ...value, [key]: event.target.value || null })}><option value="">Вхождение не выбрано</option><option value="earlier">Раннее · {candidates[0]!.utcOffset}</option><option value="later">Позднее · {candidates.at(-1)!.utcOffset}</option></select></Field>
    } catch { return null }
  }
  return <><div className="form-grid">
    <Field label={dateLabel}><input type="date" value={value.logicalDate} onChange={event => onChange({ ...value, logicalDate: event.target.value })} /></Field>
    <Field label="Начало, время (необязательно)"><input type="time" step="60" value={value.startTime} onChange={event => onChange({ ...value, startTime: event.target.value, startDisambiguation: null })} /></Field>
    <Field label="Конец, время (необязательно)"><input type="time" step="60" value={value.endTime} onChange={event => onChange({ ...value, endTime: event.target.value, endDisambiguation: null })} /></Field>
    {value.endTime && <Field label="Конец через дней" hint="0 — в выбранную дату, 1 — на следующий день. Ночь не подставляется автоматически."><input type="number" min="0" max="3652058" step="1" required value={value.endDayOffset} onChange={event => onChange({ ...value, endDayOffset: event.target.value })} /></Field>}
    <Field label="Часовой пояс времени"><input required list="timezones" value={value.timezone} onChange={event => onChange({ ...value, timezone: event.target.value })} /></Field>
    {fold(false)}{fold(true)}
  </div>{error && <p className="notice" role="status">{error}</p>}{preview?.issue && <p className="notice" role="status">{placementIssueLabels[preview.issue]}</p>}{preview?.resolved && <div className="preview"><strong>Предполагаемое время</strong><p>{instantLabel(preview.resolved.startInstant, value.timezone)} — {instantLabel(preview.resolved.endInstant, value.timezone)} · {preview.minutes} мин</p><p>Сервер проверит полный объём, разрешённые окна и занятость. Это ещё не календарный блок.</p></div>}</>
}

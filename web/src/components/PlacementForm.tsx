import { useId, useMemo, useState, type FormEvent } from 'react'
import { confirmedRead, useRuntime } from '../sync/context'
import type { OccurrenceResponse, PlanState, TaskOccurrence, UserSettings } from '../api/types'
import { assertPlacementAction, effectiveFixed, fixedConfirmation, placementActionLabels, placementActionProblem, placementActions, type PlacementAction } from '../lib/operations'
import { elapsedEnd, instantLabel, localParts, selectedInstant, today } from '../lib/time'
import { OffsetSelect } from './AvailabilityForm'
import { CommandStatus, DraftStatus, ConflictReview, Field, Panel, SubmitButton, canRebase, useCommand, useVersionedDraft } from './shared'
import { OccurrenceSummary } from './RecordSummary'
import { afterRefresh } from '../lib/command-lifecycle'
import { assertOccurrenceEditable, isCompleted } from '../lib/completion'

type PlacementFormProps = { userId: string; occurrence: TaskOccurrence; title: string; settings: UserSettings; planState: PlanState; onSaved: () => Promise<void>; onClose: () => void }
export function PlacementForm(props: PlacementFormProps) {
  return <EditablePlacementForm {...props} />
}
function EditablePlacementForm({ userId, occurrence, title, settings, planState, onSaved, onClose }: PlacementFormProps) {
  const { runtime } = useRuntime()
  const key = `placement:${occurrence.id}`
  const [review, setReview] = useState<OccurrenceResponse | null>(null)
  const block = occurrence.calendarBlock
  const parts = block ? localParts(block.startInstant, settings.timezone) : { date: today(settings.timezone), time: '09:00' }
  const draft = useVersionedDraft(userId, key, { action: (block ? 'move' : 'place') as PlacementAction, localStart: `${parts.date}T${parts.time}`, timezone: settings.timezone, utcOffset: '', fixed: !block?.fixed }, { occurrence, planState })
  const { value, base, update: setValue } = draft
  const [confirmed, setConfirmed] = useState(false)
  const command = useCommand(userId, key, current => afterRefresh(current, draft.clear, onSaved, onClose))
  const actionProblemId = useId()
  const actionProblem = placementActionProblem(base.occurrence, value.action)
  const allowedActions = placementActions(base.occurrence)
  const timed = value.action === 'place' || value.action === 'move'
  const needsConfirmation = fixedConfirmation(base.occurrence, value.action, value.fixed)
  const preview = useMemo(() => {
    if (!timed || !value.utcOffset) return null
    try { const start = selectedInstant(`${value.localStart}:00`, value.timezone, value.utcOffset); return { start, end: elapsedEnd(start, base.occurrence.remainingWorkMinutes) } } catch { return null }
  }, [timed, value.localStart, value.timezone, value.utcOffset, base.occurrence.remainingWorkMinutes])
  function change(patch: Partial<typeof value>) { setConfirmed(false); setValue({ ...value, ...patch }) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      assertOccurrenceEditable(occurrence)
      assertOccurrenceEditable(base.occurrence)
      assertPlacementAction(base.occurrence, value.action)
      if (needsConfirmation && !confirmed) throw new Error('Подтвердите изменение закреплённого времени.')
      if (timed && !preview) throw new Error('Выберите действительное локальное время и его UTC offset.')
      const common = { action: value.action, baseScheduleVersion: base.planState.scheduleVersion, allowFixedChange: needsConfirmation && confirmed }
      const body = timed ? { ...common, localStart: `${value.localStart}:00`, timezone: value.timezone, utcOffset: value.utcOffset } : value.action === 'setFixed' ? { ...common, fixed: value.fixed } : common
      await command.submit({ method: 'POST', path: `/occurrences/${occurrence.id}/placement`, version: base.occurrence.serverVersion, body })
    } catch (error) { command.setError(error as Error) }
  }
  async function rebase() {
    try { setReview(await confirmedRead<OccurrenceResponse>(runtime, `/occurrences/${occurrence.id}`)) } catch (error) { command.setError(error as Error) }
  }
  return <Panel title={`В календарь · ${title}`} onClose={onClose}><p className="muted">Метка выполнения: {base.occurrence.logicalDate}. Полный объём: {base.occurrence.remainingWorkMinutes} мин. Ограничения проверяет сервер.</p>{(isCompleted(occurrence) || isCompleted(base.occurrence)) && <p className="notice" role="status">Выполнение отмечено завершённым. Ввод сохранён, размещение доступно для просмотра. После снятия отметки перечитайте состояние перед изменением.</p>}{base.occurrence.calendarBlock && <div className="current-block"><strong>Сейчас в календаре</strong><p>{instantLabel(base.occurrence.calendarBlock.startInstant, settings.timezone)} — {instantLabel(base.occurrence.calendarBlock.endInstant, settings.timezone)}</p><p>{effectiveFixed(base.occurrence) ? 'Время защищено от случайного переноса.' : 'Время можно переносить.'}{base.occurrence.constraintsSnapshot.mobilityPolicy === 'fixedAfterPlacement' && ' Снятие отдельного флага блока не отменяет защиту в условиях выполнения.'}</p></div>}
    <form onSubmit={event => void submit(event)}><fieldset disabled={isCompleted(occurrence) || isCompleted(base.occurrence)}><Field label="Действие"><select value={value.action} aria-invalid={!!actionProblem} aria-describedby={actionProblem ? actionProblemId : undefined} onChange={event => change({ action: event.target.value as PlacementAction })}>{actionProblem && <option value={value.action} disabled>{placementActionLabels[value.action]} · недоступно, выберите действие</option>}{allowedActions.map(action => <option key={action} value={action}>{placementActionLabels[action]}</option>)}</select></Field>{actionProblem && <p id={actionProblemId} className="notice" role="status">{actionProblem}</p>}
      {timed && <><div className="form-grid"><Field label="Локальные дата и время начала"><input type="datetime-local" required step="60" value={value.localStart} onChange={event => change({ localStart: event.target.value, utcOffset: '' })} /></Field><Field label="Часовой пояс ввода"><input required list="timezones" value={value.timezone} onChange={event => change({ timezone: event.target.value, utcOffset: '' })} /></Field><OffsetSelect label="UTC offset начала" date={value.localStart.slice(0, 10)} time={value.localStart.slice(11, 16)} timezone={value.timezone} value={value.utcOffset} onChange={utcOffset => change({ utcOffset })} /></div>{preview && <div className="preview"><strong>Предстоящий блок</strong><p>{instantLabel(preview.start, value.timezone)} — {instantLabel(preview.end, value.timezone)}</p><p>{base.occurrence.remainingWorkMinutes} минут реального времени. При переводе часов локальная разница может отличаться.</p></div>}</>}
      {value.action === 'unplace' && <div className="preview"><strong>Предстоящее изменение</strong><p>Весь блок будет снят. Выполнение и его полный объём останутся в списке незапланированных.</p></div>}
      {value.action === 'setFixed' && <Field label="Фиксация календарного блока"><select value={String(value.fixed)} onChange={event => change({ fixed: event.target.value === 'true' })}><option value="true">Закрепить блок</option><option value="false">Снять фиксацию блока</option></select></Field>}
      {needsConfirmation && <label className="confirmation"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю изменение закреплённого времени: {value.action === 'move' ? 'перенести блок' : value.action === 'unplace' ? 'снять весь блок с календаря' : 'снять фиксацию блока'}.</label>}
      <SubmitButton busy={command.busy} disabled={command.blocked}>Подтвердить изменение</SubmitButton></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} />{((canRebase(command.problem) || draft.changed) || isCompleted(base.occurrence)) && <button type="button" onClick={() => void rebase()}>Проверить актуальные выполнение и расписание</button>}{review && <ConflictReview current={<OccurrenceSummary occurrence={review.occurrence} settings={settings} />} draft={<><OccurrenceSummary occurrence={base.occurrence} settings={settings} /><p>Ваше действие: {value.action === 'move' ? 'Перенос' : value.action === 'place' ? 'Размещение' : value.action === 'unplace' ? 'Снятие блока' : value.fixed ? 'Закрепить блок' : 'Снять фиксацию'}{timed && `, ${value.localStart.replace('T', ' ')}, ${value.timezone}, ${value.utcOffset || 'offset не выбран'}`}</p></>} onAccept={() => { draft.rebase(review); setConfirmed(false); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form>
  </Panel>
}

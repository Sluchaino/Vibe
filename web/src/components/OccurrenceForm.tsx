import { useRef, useState, type FormEvent } from 'react'
import { confirmedRead, useRuntime } from '../sync/context'
import type { DefinitionResponse, OccurrenceResponse, TaskDefinition, TaskOccurrence, UserSettings } from '../api/types'
import { fixedConfirmation } from '../lib/operations'
import { emptyTiming, timeIntent, timingDraft, timingPreview, workOrigin } from '../lib/task-timing'
import { TimingFields } from './TimingFields'
import { ConstraintsForm, constraintDraft, constraints } from './ConstraintsForm'
import { CommandStatus, DraftStatus, ConflictReview, Panel, SubmitButton, canRebase, useCommand, useVersionedDraft } from './shared'
import { ConstraintSummary, DefinitionSummary, OccurrenceSummary, definitionSummaryValue } from './RecordSummary'
import { afterRefresh } from '../lib/command-lifecycle'
import { assertOccurrenceEditable, isCompleted } from '../lib/completion'

export function CreateOccurrenceForm({ userId, definition, settings, onSaved, initialDate, creationOccurrenceId, beforeCreate, readOnlyDate = false }: { userId: string; definition: TaskDefinition; settings: UserSettings; onSaved: () => Promise<void>; initialDate?: string; creationOccurrenceId?: string; beforeCreate?: (date: string) => Promise<void>; readOnlyDate?: boolean }) {
  const { runtime } = useRuntime()
  const key = `create-occurrence:${definition.id}`
  const draft = useVersionedDraft(userId, key, { id: creationOccurrenceId ?? crypto.randomUUID(), logicalDate: initialDate ?? '', timing: { ...emptyTiming(settings.timezone), logicalDate: initialDate ?? '' } }, definition)
  const { value, base, update: setValue } = draft
  const [review, setReview] = useState<TaskDefinition | null>(null)
  const preparingRef = useRef(false)
  const [preparing, setPreparing] = useState(false)
  const command = useCommand(userId, key, current => afterRefresh(current, () => { draft.clear(); setValue({ id: crypto.randomUUID(), logicalDate: value.logicalDate, timing: value.timing }) }, onSaved))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (preparingRef.current) return
    preparingRef.current = true; setPreparing(true)
    try {
      if (beforeCreate) await beforeCreate(value.logicalDate)
      const selected = value.timing ?? { ...emptyTiming(settings.timezone), logicalDate: value.logicalDate }
      const timing = timeIntent(selected)
      if (base.workOrigin === 'interval' && !(timing?.startLocalTime && timing.endLocalTime)) throw new Error('У этой задачи объём вычисляется по полному интервалу. Задайте начало и конец.')
      if (base.workOrigin === 'unspecified' && timing?.startLocalTime && timing.endLocalTime) throw new Error('В описании задачи выбран неизвестный объём. Сначала явно измените его на вычисление по интервалу либо ручной объём.')
      await command.submit({ method: 'POST', path: `/task-definitions/${definition.id}/occurrences`, body: { id: value.id, definitionVersion: base.serverVersion, logicalDate: selected.logicalDate || null, timeIntent: timing } })
    } catch (error) { command.setError(error as Error) } finally { preparingRef.current = false; setPreparing(false) }
  }
  async function rebase() { try { setReview((await confirmedRead<DefinitionResponse>(runtime, `/task-definitions/${definition.id}`)).definition) } catch (error) { command.setError(error as Error) } }
  return <section className="occurrence-create"><h3>Создать отдельное выполнение</h3><p className="muted">Сервер скопирует условия задачи: {base.durationPolicy ? base.durationPolicy.requiredWorkMinutes + " мин" : base.workOrigin === "interval" ? "по интервалу на эту дату" : "объём не задан"}, {base.mobilityPolicy === 'fixedAfterPlacement' ? 'время закрепляется после размещения' : 'можно переносить'}. Дата и часы необязательны. При достаточных условиях сервер один раз попробует занять время; отказ будет показан у выполнения.</p><form onSubmit={event => void submit(event)}><fieldset disabled={!!beforeCreate && (preparing || command.busy || !!command.pending)}><fieldset disabled={readOnlyDate}><TimingFields value={value.timing ?? { ...emptyTiming(settings.timezone), logicalDate: value.logicalDate }} minutes={base.workOrigin === "manual" ? String(base.durationPolicy!.requiredWorkMinutes) : ""} onChange={timing => setValue({ ...value, timing, logicalDate: timing.logicalDate })} /></fieldset><SubmitButton busy={command.busy || preparing} disabled={command.blocked}>Создать выполнение</SubmitButton></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} />{(canRebase(command.problem) || draft.changed) && <button type="button" onClick={() => void rebase()}>Проверить актуальные условия, сохранив дату</button>}{review && <ConflictReview current={<DefinitionSummary value={definitionSummaryValue(review)} categories={[]} placeName={settings.place?.name ?? 'не задано'} />} draft={<DefinitionSummary value={definitionSummaryValue(base)} categories={[]} placeName={settings.place?.name ?? 'не задано'} />} onAccept={() => { draft.rebase(review); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></section>
}
type OccurrenceFormProps = { userId: string; occurrence: TaskOccurrence; title: string; settings: UserSettings; onSaved: () => Promise<void>; onClose: () => void }
export function OccurrenceForm(props: OccurrenceFormProps) {
  return <EditableOccurrenceForm {...props} />
}
function EditableOccurrenceForm({ userId, occurrence, title, settings, onSaved, onClose }: OccurrenceFormProps) {
  const { runtime } = useRuntime()
  const key = `occurrence:${occurrence.id}`
  const draft = useVersionedDraft(userId, key, { ...constraintDraft(occurrence.constraintsSnapshot), logicalDate: occurrence.logicalDate ?? '', timing: timingDraft(occurrence.logicalDate, occurrence.timeIntent, settings.timezone) }, occurrence)
  const { value, base, update: setValue } = draft
  const [review, setReview] = useState<TaskOccurrence | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const command = useCommand(userId, key, current => afterRefresh(current, draft.clear, onSaved, onClose))
  const needsConfirmation = fixedConfirmation(base, 'snapshot', undefined, value.mobilityPolicy)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      assertOccurrenceEditable(occurrence); assertOccurrenceEditable(base)
      if (needsConfirmation && !confirmed) throw new Error('Подтвердите снятие защиты закреплённого времени.')
      const selected = value.timing ?? timingDraft(value.logicalDate, base.timeIntent ?? null, settings.timezone)
      const timing = timeIntent(selected), snapshot = constraints({ ...value, workOrigin: workOrigin(value.minutes, timing) })
      if (timingPreview(selected.logicalDate || null, timing, snapshot.durationPolicy?.requiredWorkMinutes ?? null).issue === 'workMismatch') throw new Error('Часы не соответствуют полному ручному объёму либо конец не позже начала.')
      await command.submit({ method: 'PUT', path: `/occurrences/${occurrence.id}`, version: base.serverVersion, body: { logicalDate: selected.logicalDate || null, constraintsSnapshot: snapshot, timeIntent: timing, allowFixedChange: needsConfirmation && confirmed } })
    } catch (error) { command.setError(error as Error) }
  }
  async function rebase() { try { setReview((await confirmedRead<OccurrenceResponse>(runtime, `/occurrences/${occurrence.id}`)).occurrence) } catch (error) { command.setError(error as Error) } }
  return <Panel title={`Условия выполнения · ${title}`} onClose={onClose}><p className="muted">Эта форма меняет только конкретное выполнение. Название, категория, важность, сложность и приоритет берутся из описания задачи. Условия не копируются заново из задачи.</p>{(isCompleted(occurrence) || isCompleted(base)) && <p className="notice" role="status">Эта редакция отмечена завершённой. Ввод сохранён, изменение условий приостановлено. После снятия отметки перечитайте состояние и выберите актуальную редакцию.</p>}{base.calendarBlock && <p className="notice">У выполнения есть блок. Если новый объём или окна несовместимы с ним, сначала явно снимите выполнение с календаря.</p>}<form onSubmit={event => void submit(event)}><fieldset disabled={isCompleted(occurrence) || isCompleted(base)}><TimingFields value={value.timing ?? timingDraft(value.logicalDate, base.timeIntent ?? null, settings.timezone)} minutes={value.minutes} onChange={timing => setValue({ ...value, timing, logicalDate: timing.logicalDate })} /><ConstraintsForm value={value} onChange={next => { setConfirmed(false); setValue({ ...value, ...next }) }} placeName={settings.place?.name ?? 'не задано'} />{needsConfirmation && <label className="confirmation"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю снятие защиты закреплённого времени для этого выполнения.</label>}<SubmitButton busy={command.busy} disabled={command.blocked} /></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} />{((canRebase(command.problem) || draft.changed) || isCompleted(base)) && <button type="button" onClick={() => void rebase()}>Проверить актуальную редакцию</button>}{review && <ConflictReview current={<OccurrenceSummary occurrence={review} settings={settings} />} draft={<><p>Дата выполнения: {value.logicalDate}</p><ConstraintSummary value={value} placeName={settings.place?.name ?? 'не задано'} /></>} onAccept={() => { draft.rebase(review); setConfirmed(false); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></Panel>
}

import { useState, type FormEvent } from 'react'
import { read } from '../api/client'
import type { DefinitionResponse, OccurrenceResponse, TaskDefinition, TaskOccurrence, UserSettings } from '../api/types'
import { fixedConfirmation } from '../lib/operations'
import { today } from '../lib/time'
import { ConstraintsForm, constraintDraft, constraints } from './ConstraintsForm'
import { CommandStatus, ConflictReview, Field, Panel, SubmitButton, canRebase, useCommand, useVersionedDraft } from './shared'
import { ConstraintSummary, DefinitionSummary, OccurrenceSummary, definitionSummaryValue } from './RecordSummary'
import { afterRefresh } from '../lib/command-lifecycle'
import { assertOccurrenceEditable, isCompleted } from '../lib/completion'
import { OccurrenceReadOnly } from './OccurrenceReadOnly'

export function CreateOccurrenceForm({ userId, definition, settings, onSaved }: { userId: string; definition: TaskDefinition; settings: UserSettings; onSaved: () => Promise<void> }) {
  const key = `create-occurrence:${definition.id}`
  const draft = useVersionedDraft(userId, key, { id: crypto.randomUUID(), logicalDate: today(settings.timezone) }, definition)
  const { value, base, update: setValue } = draft
  const [review, setReview] = useState<TaskDefinition | null>(null)
  const command = useCommand(userId, key, current => afterRefresh(current, () => { draft.clear(); setValue({ id: crypto.randomUUID(), logicalDate: value.logicalDate }) }, onSaved))
  async function submit(event: FormEvent) { event.preventDefault(); await command.submit({ method: 'POST', path: `/task-definitions/${definition.id}/occurrences`, body: { id: value.id, definitionVersion: base.serverVersion, logicalDate: value.logicalDate } }) }
  async function rebase() { try { setReview((await read<DefinitionResponse>(`/task-definitions/${definition.id}`)).definition) } catch (error) { command.setError(error as Error) } }
  return <section className="occurrence-create"><h3>Создать отдельное выполнение</h3><p className="muted">Сервер скопирует условия задачи: {base.durationPolicy.requiredWorkMinutes} мин, {base.mobilityPolicy === 'fixedAfterPlacement' ? 'время закрепляется после размещения' : 'можно переносить'}. Дата — метка выполнения; время в календаре выбирается отдельно.</p><form onSubmit={event => void submit(event)}><fieldset disabled={command.busy || !!command.pending}><Field label="Дата выполнения"><input type="date" required value={value.logicalDate} onChange={event => setValue({ ...value, logicalDate: event.target.value })} /></Field><SubmitButton busy={command.busy}>Создать выполнение</SubmitButton></fieldset><CommandStatus command={command} />{canRebase(command.problem) && <button type="button" onClick={() => void rebase()}>Проверить актуальные условия, сохранив дату</button>}{review && <ConflictReview current={<DefinitionSummary value={definitionSummaryValue(review)} categories={[]} placeName={settings.place?.name ?? 'не задано'} />} draft={<DefinitionSummary value={definitionSummaryValue(base)} categories={[]} placeName={settings.place?.name ?? 'не задано'} />} onAccept={() => { draft.rebase(review); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></section>
}
type OccurrenceFormProps = { userId: string; occurrence: TaskOccurrence; title: string; settings: UserSettings; onSaved: () => Promise<void>; onClose: () => void }
export function OccurrenceForm(props: OccurrenceFormProps) {
  if (isCompleted(props.occurrence)) return <OccurrenceReadOnly title={`Условия выполнения · ${props.title}`} occurrence={props.occurrence} settings={props.settings} onClose={props.onClose} />
  return <EditableOccurrenceForm {...props} />
}
function EditableOccurrenceForm({ userId, occurrence, title, settings, onSaved, onClose }: OccurrenceFormProps) {
  const key = `occurrence:${occurrence.id}`
  const draft = useVersionedDraft(userId, key, { ...constraintDraft(occurrence.constraintsSnapshot), logicalDate: occurrence.logicalDate }, occurrence)
  const { value, base, update: setValue } = draft
  const [review, setReview] = useState<TaskOccurrence | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const command = useCommand(userId, key, current => afterRefresh(current, draft.clear, onSaved, onClose))
  const needsConfirmation = fixedConfirmation(base, 'snapshot', undefined, value.mobilityPolicy)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { assertOccurrenceEditable(occurrence); assertOccurrenceEditable(base); if (needsConfirmation && !confirmed) throw new Error('Подтвердите снятие защиты закреплённого времени.'); await command.submit({ method: 'PUT', path: `/occurrences/${occurrence.id}`, version: base.serverVersion, body: { logicalDate: value.logicalDate, constraintsSnapshot: constraints(value), allowFixedChange: needsConfirmation && confirmed } }) } catch (error) { command.setError(error as Error) }
  }
  async function rebase() { try { setReview((await read<OccurrenceResponse>(`/occurrences/${occurrence.id}`)).occurrence) } catch (error) { command.setError(error as Error) } }
  return <Panel title={`Условия выполнения · ${title}`} onClose={onClose}><p className="muted">Эта форма меняет только конкретное выполнение. Название, категория, важность, сложность и приоритет берутся из описания задачи. Условия не копируются заново из задачи.</p>{isCompleted(base) && <p className="notice" role="status">Эта редакция отмечена завершённой. Ввод сохранён, изменение условий приостановлено. После снятия отметки перечитайте состояние и выберите актуальную редакцию.</p>}{base.calendarBlock && <p className="notice">У выполнения есть блок. Если новый объём или окна несовместимы с ним, сначала явно снимите выполнение с календаря.</p>}<form onSubmit={event => void submit(event)}><fieldset disabled={command.busy || !!command.pending || isCompleted(base)}><Field label="Дата выполнения"><input type="date" required value={value.logicalDate} onChange={event => setValue({ ...value, logicalDate: event.target.value })} /></Field><ConstraintsForm value={value} onChange={next => { setConfirmed(false); setValue({ ...value, ...next }) }} placeName={settings.place?.name ?? 'не задано'} />{needsConfirmation && <label className="confirmation"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю снятие защиты закреплённого времени для этого выполнения.</label>}<SubmitButton busy={command.busy} /></fieldset><CommandStatus command={command} />{(canRebase(command.problem) || isCompleted(base)) && <button type="button" onClick={() => void rebase()}>Проверить актуальную редакцию</button>}{review && <ConflictReview current={<OccurrenceSummary occurrence={review} settings={settings} />} draft={<><p>Дата выполнения: {value.logicalDate}</p><ConstraintSummary value={value} placeName={settings.place?.name ?? 'не задано'} /></>} onAccept={() => { draft.rebase(review); setConfirmed(false); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></Panel>
}

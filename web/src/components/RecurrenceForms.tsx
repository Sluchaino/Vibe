import { useRef, useState, type FormEvent } from 'react'
import type { DefinitionResponse, RecurrenceResponse, RecurrenceRule, TaskDefinition, UserSettings } from '../api/types'
import { createRecurrenceCommand, recurrenceInput, stopRecurrenceCommand, type RecurrenceDraft } from '../lib/recurrence'
import { afterRefresh } from '../lib/command-lifecycle'
import { confirmedRead, useRuntime, useSyncState } from '../sync/context'
import { CommandStatus, ConflictReview, DraftStatus, Panel, SubmitButton, canRebase, useCommand, useVersionedDraft } from './shared'
import { DefinitionSummary, definitionSummaryValue } from './RecordSummary'
import { RecurrenceFields, RecurrenceSummary } from './RecurrenceFields'

export function CreateRecurrenceForm({ userId, definition, schedule, settings, beforeCreate, onSaved, existingRule }: { userId: string; definition: TaskDefinition; schedule: RecurrenceDraft; settings: UserSettings; beforeCreate: (schedule: RecurrenceDraft) => Promise<void>; onSaved: () => Promise<void>; existingRule?: RecurrenceRule }) {
  const { runtime } = useRuntime(), sync = useSyncState()
  const key = `create-recurrence:${definition.id}`
  const draft = useVersionedDraft(userId, key, schedule, definition)
  const { value, base, update } = draft
  const [review, setReview] = useState<TaskDefinition | null>(null)
  const preparing = useRef(false), [busy, setBusy] = useState(false)
  const command = useCommand(userId, key, current => afterRefresh(current, draft.clear, onSaved))
  async function submit(event: FormEvent) {
    event.preventDefault(); if (preparing.current || command.blocked || existingRule) return
    preparing.current = true; setBusy(true)
    try { recurrenceInput(value); await beforeCreate(value); await command.submit(createRecurrenceCommand(base, value)) } catch (error) { command.setError(error as Error) } finally { preparing.current = false; setBusy(false) }
  }
  async function reviewDefinition() { try { setReview((await confirmedRead<DefinitionResponse>(runtime, `/task-definitions/${definition.id}`)).definition) } catch (error) { command.setError(error as Error) } }
  return <section><h3>Подтвердить повторение</h3><p className="muted">Описание уже сохранено. Следующий шаг создаст правило и отдельные выполнения без времени. Изменения описания сравниваются перед новой попыткой.</p><form onSubmit={event => void submit(event)}><fieldset disabled={busy || command.busy || !!command.pending}><RecurrenceFields value={value} onChange={update} /><SubmitButton busy={busy || command.busy} disabled={command.blocked || !!existingRule}>Создать повторение</SubmitButton></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} />{(draft.changed || canRebase(command.problem)) && <button type="button" onClick={() => void reviewDefinition()}>Сравнить актуальное описание</button>}{review && <ConflictReview current={<DefinitionSummary value={definitionSummaryValue(review)} categories={sync.projection ? [...sync.projection.categories.values()] : []} placeName={settings.place?.name ?? 'Место'} />} draft={<><DefinitionSummary value={definitionSummaryValue(base)} categories={sync.projection ? [...sync.projection.categories.values()] : []} placeName={settings.place?.name ?? 'Место'} /><p>Выбранные дни, даты и зона повторения сохранятся.</p></>} onAccept={() => { draft.rebase(review); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></section>
}
export function RecurrenceStopForm({ userId, rule, title, onSaved, onClose }: { userId: string; rule: RecurrenceRule; title: string; onSaved: () => Promise<void>; onClose: () => void }) {
  const { runtime } = useRuntime()
  const key = `recurrence-stop:${rule.id}`
  const draft = useVersionedDraft(userId, key, { confirmed: false }, rule)
  const [review, setReview] = useState<RecurrenceRule | null>(null)
  const command = useCommand(userId, key, async current => { await onSaved(); if (!current()) return; const fresh = runtime.coordinator.snapshot().projection?.recurrences.get(rule.id); if (fresh) draft.finish({ confirmed: false }, fresh) })
  async function submit(event: FormEvent) { event.preventDefault(); try { if (!draft.value.confirmed) throw new Error('Подтвердите остановку повторения.'); await command.submit(stopRecurrenceCommand(draft.base)) } catch (error) { command.setError(error as Error) } }
  async function refreshRule() { try { setReview((await confirmedRead<RecurrenceResponse>(runtime, `/recurrence-rules/${rule.id}`)).rule) } catch (error) { command.setError(error as Error) } }
  return <Panel title={`Повторение · ${title}`} onClose={onClose}><RecurrenceSummary rule={rule} /><p className="notice">Остановка прекращает создание новых выполнений. Уже созданные, включая будущие, останутся вместе с их временем и отметками. Возобновление и изменение правила в этом этапе не предусмотрены.</p><form onSubmit={event => void submit(event)}><fieldset disabled={!rule.enabled || command.busy}><label className="confirmation"><input type="checkbox" required checked={draft.value.confirmed} onChange={event => draft.update({ confirmed: event.target.checked })} />Остановить создание новых выполнений. Уже созданные сохранятся.</label><SubmitButton busy={command.busy} disabled={command.blocked || !draft.base.enabled}>{rule.enabled ? 'Остановить повторение' : 'Повторение остановлено'}</SubmitButton></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} />{(draft.changed || canRebase(command.problem)) && <button type="button" onClick={() => void refreshRule()}>Сравнить актуальное правило</button>}{review && <ConflictReview current={<RecurrenceSummary rule={review} />} draft={<RecurrenceSummary rule={draft.base} />} onAccept={() => { draft.rebase(review); draft.update({ confirmed: false }); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></Panel>
}

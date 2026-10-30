import { useRef, useState } from 'react'
import type { Category, UserSettings } from '../api/types'
import type { DraftRecord } from '../persistence/database'
import { creationStage, creationStartContinuation, creationStartEditorState, isCreationRecord, prepareCreation, type CreationIntent, type CreationStart } from '../lib/creation'
import { instantLabel, localParts } from '../lib/time'
import { RuntimeContext, useLocalState, useRuntime, useSyncState } from '../sync/context'
import { DefinitionForm } from './DefinitionForm'
import { CreateOccurrenceForm } from './OccurrenceForm'
import { PlacementForm } from './PlacementForm'
import { Panel } from './shared'
import { CreationStartEditor } from './CreationStartEditor'

type CreationRecord = DraftRecord & { value: CreationIntent }
export function TaskCreationFlow({ userId, settings, categories, initialDate, onSaved, onClose, onFinish }: { userId: string; settings: UserSettings; categories: Category[]; initialDate: string; onSaved: () => Promise<void>; onClose: () => void; onFinish: (date: string) => void }) {
  const context = useRuntime(), local = useLocalState(), sync = useSyncState()
  const { runtime, restore } = context
  const restoredDefinitionId = restore?.key === 'new-definition' ? (restore.value as { id?: string }).id : undefined
  const [record, setRecord] = useState<CreationRecord | undefined>(() => restore?.key.startsWith('creation-start:') ? creationStartContinuation(userId, restore, local.drafts, sync.projection!) : isCreationRecord(restore) ? restore : local.drafts.find((item): item is CreationRecord => isCreationRecord(item) && item.value.definitionId === restoredDefinitionId))
  const current = useRef(record)
  const [choosingTime, setChoosingTime] = useState(false)
  const [editingStart, setEditingStart] = useState(() => !!record && !!restore?.key.startsWith('creation-start:'))
  const projection = sync.projection!
  const definition = record ? projection.definitions.get(record.value.definitionId.toLowerCase()) : undefined
  const occurrence = record ? projection.occurrences.get(record.value.occurrenceId.toLowerCase()) : undefined
  const stage = record ? creationStage(projection, record.value) : 'definition'
  const startEditor = record ? creationStartEditorState(record, editingStart, !!local.pending, sync.status !== 'ready' || stage === 'placed' || stage === 'completed') : null
  function finish() { void runtime.requestLeave(() => { if (occurrence?.calendarBlock) onFinish(localParts(occurrence.calendarBlock.startInstant, settings.timezone).date); else if (occurrence?.logicalDate) onFinish(occurrence.logicalDate); onClose() }) }
  async function placementSaved() {
    await onSaved()
    const fresh = record && runtime.coordinator.snapshot().projection?.occurrences.get(record.value.occurrenceId.toLowerCase())
    if (fresh && !runtime.hasUnsaved()) { if (fresh.calendarBlock) onFinish(localParts(fresh.calendarBlock.startInstant, settings.timezone).date); else if (fresh.logicalDate) onFinish(fresh.logicalDate) }
  }
  async function prepare(definitionId: string, start: CreationStart) {
    if (runtime.snapshot().pending) throw new Error('Сначала разрешите оставшуюся отправку. Выбранное начало сохранено в форме.')
    const next = prepareCreation(userId, definitionId, start.localStart.slice(0, 10), current.current, start)
    await runtime.saveDraftAndWait(next)
    current.current = next
    setRecord(next)
  }
  async function beforeOccurrence(date: string) {
    if (!current.current) throw new Error('Не найдено сохранённое продолжение создания.')
    if (date !== current.current.value.logicalDate) throw new Error('Дата отличается от сохранённого начала. Вернитесь к выбору начала, прежде чем создавать выполнение.')
    // No date/time is requested again: the occurrence confirms the initial choice.
    const next = prepareCreation(userId, current.current.value.definitionId, date, current.current)
    await runtime.saveDraftAndWait(next); current.current = next; setRecord(next)
  }
  if (restore?.key.startsWith('creation-start:') && !record) return <Panel title="Восстановление выбранного начала" onClose={onClose}><p className="notice" role="alert">Продолжение создания больше недоступно. Черновик сохранён; новая задача автоматически не создаётся.</p></Panel>
  if (stage === 'definition') {
    const savedDraft = record ? local.drafts.find(item => item.key === 'new-definition' && (item.value as { id?: string }).id === record.value.definitionId) : undefined
    return <RuntimeContext.Provider value={{ ...context, restore: savedDraft ?? restore }}>
      {record && <p className="notice" role="status">Создание сохранено в этом браузере. Описание задачи пока не подтверждено; оставшаяся отправка восстанавливается отдельно. Дата первого выполнения: {record.value.logicalDate}.</p>}
      <DefinitionForm userId={userId} settings={settings} categories={categories} moreCategories={false} onMoreCategories={() => undefined} onSaved={onSaved} onClose={onClose} initialDate={record?.value.logicalDate ?? initialDate} initialStart={record ? record.value.start ?? null : undefined} creationDefinitionId={record?.value.definitionId} onPrepare={prepare} />
    </RuntimeContext.Provider>
  }
  return <Panel title={`Новая задача · ${definition?.title ?? 'Сохранённая задача'}`} onClose={onClose}>
    <ol className="creation-progress" aria-label="Этапы создания"><li>Описание задачи сохранено</li><li>{occurrence ? `Выполнение создано на ${occurrence.logicalDate}` : `Следующий шаг: выполнение на ${record!.value.logicalDate}`}</li><li>{stage === 'placed' ? 'Время в календаре подтверждено' : 'Отдельно подтвердите выбранное начало'}</li></ol>
    <p className="muted">Каждый шаг сохраняется отдельно. Закрытие не отменяет уже созданное. Продолжить можно из календаря или из сохранённого в браузере.</p>
    {local.pending && <p className="notice" role="status">Сначала дождитесь подтверждения оставшейся отправки или разрешите её в разделе «Сохранённое в браузере».</p>}
    {record?.value.start && <p className="notice">Выбранное начало: {record.value.start.localStart.replace('T', ' ')} · {record.value.start.timezone}. Дата и время уже сохранены; размещение подтверждается отдельно.</p>}
    {record && startEditor?.visible && <CreationStartEditor key={startEditor.key} userId={userId} intent={record.value} timezone={settings.timezone} disabled={startEditor.disabled} onSave={async start => { await prepare(record.value.definitionId, start); setEditingStart(false) }} />}
    {record?.value.start && !editingStart && !occurrence?.calendarBlock && <button type="button" disabled={!!local.pending} onClick={() => void runtime.requestLeave(() => { setChoosingTime(false); setEditingStart(true) })}>Вернуться к изменению начала</button>}
    {stage === 'occurrence' && definition && record?.value.start && !editingStart && <RuntimeContext.Provider value={{ ...context, restore: local.drafts.find(item => item.key === `create-occurrence:${definition.id}` && (item.value as { id?: string; logicalDate?: string }).id === record.value.occurrenceId && (item.value as { logicalDate?: string }).logicalDate === record.value.logicalDate) ?? restore }}><CreateOccurrenceForm key={record.draftId} userId={userId} definition={definition} settings={settings} initialDate={record.value.logicalDate} readOnlyDate creationOccurrenceId={record.value.occurrenceId} beforeCreate={beforeOccurrence} onSaved={onSaved} /></RuntimeContext.Provider>}
    {occurrence && stage === 'time' && <><p className="notice notice--success">Задача и выполнение на {occurrence.logicalDate} сохранены. Пока они не занимают время в календаре.</p><div className="actions"><button type="button" className="primary" disabled={!!local.pending || sync.status !== 'ready' || !record?.value.start || editingStart} onClick={() => setChoosingTime(true)}>Подтвердить выбранное время</button><button type="button" onClick={finish}>Готово без времени</button></div></>}
    {occurrence && stage === 'placed' && <p className="notice notice--success" role="status">В календаре: {instantLabel(occurrence.calendarBlock!.startInstant, settings.timezone)} — {instantLabel(occurrence.calendarBlock!.endInstant, settings.timezone)}.</p>}
    {stage === 'completed' && <p className="notice" role="status">Это выполнение уже завершено. Условия и размещение доступны для просмотра в календаре.</p>}
    {(stage === 'placed' || stage === 'completed') && <button type="button" className="primary" onClick={finish}>Готово</button>}
    {choosingTime && occurrence && record?.value.start && !editingStart && <RuntimeContext.Provider value={{ ...context, restore: null }}><PlacementForm key={`${occurrence.id}:${record.revision}`} userId={userId} occurrence={occurrence} title={definition?.title ?? 'Выполнение'} settings={settings} planState={projection.planState} initialStart={record.value.start} lockStart onSaved={placementSaved} onClose={() => setChoosingTime(false)} /></RuntimeContext.Provider>}
  </Panel>
}

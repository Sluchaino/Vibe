import { useRef, useState } from 'react'
import type { Category, UserSettings } from '../api/types'
import { defaultRecurrence, prepareRecurring, recurringRestoration, recurringStage, type RecurrenceDraft, type RecurringRecord } from '../lib/recurrence'
import { recurrenceForDefinition } from '../sync/projection'
import { RuntimeContext, useLocalState, useRuntime, useSyncState } from '../sync/context'
import { DefinitionForm } from './DefinitionForm'
import { CreateRecurrenceForm, RecurrenceStopForm } from './RecurrenceForms'
import { Panel } from './shared'

export function RecurringCreationFlow({ userId, settings, categories, initialDate, onSaved, onClose }: { userId: string; settings: UserSettings; categories: Category[]; initialDate: string; onSaved: () => Promise<void>; onClose: () => void }) {
  const context = useRuntime(), { runtime, restore } = context, local = useLocalState(), sync = useSyncState()
  const [record, setRecord] = useState<RecurringRecord | undefined>(() => restore ? recurringRestoration(userId, restore, local.drafts, sync.projection!) : undefined)
  const current = useRef(record)
  const [initial] = useState(() => record?.value.schedule ?? defaultRecurrence(settings.timezone, initialDate))
  const [view, setView] = useState(() => record ? recurringStage(sync.projection!, record.value) : 'definition')
  const projection = sync.projection!, definition = record ? projection.definitions.get(record.value.definitionId.toLowerCase()) : undefined
  const rule = record ? recurrenceForDefinition(projection, record.value.definitionId) : undefined
  async function finished(next: 'createRule' | 'rule') { await onSaved(); if (runtime.current() && !runtime.hasUnsaved()) setView(next) }
  async function prepare(definitionId: string, schedule: RecurrenceDraft) { if (runtime.snapshot().pending) throw new Error('Сначала разрешите оставшуюся отправку.'); const next = prepareRecurring(userId, definitionId, schedule, current.current); await runtime.saveDraftAndWait(next); current.current = next; setRecord(next) }
  if (restore?.key.startsWith('create-recurrence:') && !record) return <Panel title="Восстановление повторения" onClose={onClose}><p role="alert">Продолжение или задача недоступны. Черновик сохранён; новые сущности автоматически не создаются.</p></Panel>
  if (view === 'definition') {
    const saved = record ? local.drafts.find(row => row.key === 'new-recurring-definition' && (row.value as { id?: string }).id === record.value.definitionId) : undefined
    return <RuntimeContext.Provider value={{ ...context, restore: saved ?? restore }}>{definition && <p className="notice">Описание уже создано. Ваш новый ввод сохранён в форме. <button type="button" onClick={() => void runtime.requestLeave(() => setView('createRule'))}>Перейти к повторению сохранённого описания</button></p>}<DefinitionForm userId={userId} settings={settings} categories={categories} moreCategories={false} onMoreCategories={() => undefined} onSaved={() => finished('createRule')} onClose={onClose} creationCommitted={!!definition} creationDefinitionId={record?.value.definitionId} recurring={{ initial: record?.value.schedule ?? initial, prepare }} /></RuntimeContext.Provider>
  }
  if (view === 'rule') return rule ? <RecurrenceStopForm userId={userId} rule={rule} title={definition?.title ?? 'Повторяющаяся задача'} onSaved={onSaved} onClose={onClose} /> : <Panel title="Повторение недоступно" onClose={onClose}><p>Правило отсутствует в подтверждённых данных. Ввод сохранён; новое правило автоматически не создаётся.</p></Panel>
  const savedRule = local.drafts.find(row => row.key === `create-recurrence:${definition?.id}` && (row.value as RecurrenceDraft).id === record?.value.schedule.id)
  return <Panel title={`Повторяющаяся · ${definition?.title ?? 'Задача'}`} onClose={onClose}><p className="notice notice--success">Описание сохранено. Повторение ещё не подтверждено. Закрытие не отменяет описание; продолжение сохранено в браузере.</p>{rule && <p className="notice">Правило уже появилось в подтверждённых данных. Ваш ввод сохранён. <button type="button" onClick={() => void runtime.requestLeave(() => setView('rule'))}>Открыть существующее повторение</button></p>}{definition && record && <RuntimeContext.Provider value={{ ...context, restore: restore?.key === `create-recurrence:${definition.id}` ? restore : savedRule ?? null }}><CreateRecurrenceForm key={record.value.schedule.id} userId={userId} definition={definition} schedule={record.value.schedule} settings={settings} beforeCreate={schedule => prepare(definition.id, schedule)} existingRule={rule} onSaved={() => finished('rule')} /></RuntimeContext.Provider>}</Panel>
}

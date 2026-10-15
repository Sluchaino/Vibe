import { useEffect, useState } from 'react'
import type { OccurrenceResponse, TaskOccurrence, UserSettings } from '../api/types'
import { completionCommand, completionIntent, hasCurrentCompletion, isCompleted } from '../lib/completion'
import { completionTimeLabel } from '../lib/time'
import { CommandStatus, Panel, useCommand } from './shared'
import { OccurrenceSummary } from './RecordSummary'

export function CompletionForm({ userId, occurrence, title, settings, refreshRequired, onRefresh, onClose, onEdit, onPlace }: { userId: string; occurrence: TaskOccurrence; title: string; settings: UserSettings; refreshRequired: boolean; onRefresh: (id: string) => Promise<OccurrenceResponse>; onClose: () => void; onEdit: () => void; onPlace: () => void }) {
  const [observed, setObserved] = useState(occurrence)
  const [reloadNeeded, setReloadNeeded] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [lastReopen, setLastReopen] = useState(false)
  useEffect(() => { setObserved(occurrence) }, [occurrence])
  const command = useCommand(userId, `completion:${occurrence.id}`, async current => {
    if (current()) setReloadNeeded(true)
    // This authoritative refresh also runs if the editor closed while awaiting
    // ACK. UI updates are independently guarded by mount/identity/opId.
    const fresh = await onRefresh(occurrence.id)
    if (current()) { setObserved(fresh.occurrence); setReloadNeeded(false) }
  })
  async function submit() {
    if (reloadNeeded || refreshRequired) { command.setError(new Error('Сначала обновите состояние после предыдущего действия.')); return }
    try {
      const intent = completionIntent(observed)
      setLastReopen(intent.action === 'reopen')
      await command.submit(completionCommand(observed, intent), { value: intent, base: observed })
    } catch (error) { command.setError(error as Error) }
  }
  async function reload() {
    setReloading(true); command.setError(null)
    try { const fresh = await onRefresh(occurrence.id); setObserved(fresh.occurrence); setReloadNeeded(false) } catch (error) { setReloadNeeded(true); command.setError(error as Error) } finally { setReloading(false) }
  }
  const completed = isCompleted(observed)
  const blocked = command.blocked || command.busy || reloading || reloadNeeded || refreshRequired || !hasCurrentCompletion(observed)
  return <Panel title={`Завершение · ${title}`} onClose={onClose}>
    <div className={`completion-state ${completed ? 'completion-state--done' : ''}`} role="status"><strong>{completed ? 'Выполнено' : 'Не выполнено'}</strong>{observed.completion && <p>Отмечено выполненным {completionTimeLabel(observed.completion.completedAt, settings.timezone)} · {settings.timezone}</p>}</div>
    <p className="muted">Отметка относится только к этому выполнению. Календарный блок и его фиксация сохраняются.</p>
    <OccurrenceSummary occurrence={observed} settings={settings} />
    {command.pending && <p className="notice">Повторится первоначальное действие. Новая отметка не будет отменена вместо выбранной ранее.</p>}
    {(reloadNeeded || refreshRequired) && <p className="notice notice--error" role="alert">Последнее действие требует перечитывания. До успешного обновления показана прежняя редакция; новые отметки и отмены приостановлены.</p>}
    <div className="actions"><button type="button" className="primary" disabled={blocked} onClick={() => void submit()}>{command.busy ? 'Сохраняем…' : completed ? 'Снять отметку' : lastReopen ? 'Отметить снова' : 'Отметить выполненным'}</button><button type="button" disabled={command.busy || reloading} onClick={() => void reload()}>{reloading ? 'Обновляем…' : 'Обновить состояние'}</button></div>
    <CommandStatus command={command} />
    <div className="actions"><button type="button" className="text-button" onClick={onEdit}>Просмотреть условия</button><button type="button" disabled={completed || blocked} onClick={onPlace}>Изменить размещение</button></div>
  </Panel>
}

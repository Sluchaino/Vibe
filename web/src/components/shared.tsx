import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../api/client'
import type { ProblemDetails } from '../api/types'
import type { Command } from '../lib/operations'
import type { CurrentCommandGuard } from '../lib/command-lifecycle'
import type { DraftRecord } from '../persistence/database'
import { useLocalState, useRuntime, useSyncState } from '../sync/context'
import { finishDraft, openEditorDraft, sameData, sameDraftRevision } from '../lib/durable-draft'

export function useVersionedDraft<Value, Base>(userId: string, key: string, initial: Value, currentBase: Base) {
  const { runtime, restore } = useRuntime()
  const [record, setRecord] = useState<DraftRecord>(() => openEditorDraft(userId, key, initial, currentBase, restore))
  const current = useRef(record)
  current.current = record
  useEffect(() => {
    const getter = () => current.current
    runtime.editors.set(key, getter)
    if (restore?.key === key) runtime.saveDraft(current.current)
    return () => { if (runtime.editors.get(key) === getter) runtime.editors.delete(key) }
  }, [runtime, key])
  function change(patch: Partial<Pick<DraftRecord, 'value' | 'base'>>) {
    const next = { ...current.current, ...structuredClone(patch), revision: current.current.revision + 1, updatedAt: Date.now() }
    current.current = next
    setRecord(next)
    runtime.saveDraft(next)
  }
  return { value: record.value as Value, base: record.base as Base, draftId: record.draftId,
    changed: !sameData(record.base, currentBase),
    update: (value: Value) => change({ value }), rebase: (base: Base) => change({ base }),
    finish: (value: Value, base: Base) => { const next = finishDraft(current.current, current.current, value, base); current.current = next; setRecord(next) },
    // Conditional cleanup is performed by the pending CAS using the submitted
    // revision. A late callback may never delete a newer local draft.
    clear: () => undefined }
}
export function useDraft<T>(userId: string, key: string, initial: T) {
  const draft = useVersionedDraft(userId, key, initial, null)
  return [draft.value, draft.update, draft.clear] as const
}
export function DraftStatus({ draft }: { draft: { changed: boolean } }) {
  return <p className="muted" role="status">Ввод сохраняется в этом браузере.{draft.changed && ' На сервере появилась другая редакция. Ваш ввод и исходная база сохранены; сравните редакции перед новой отправкой.'}</p>
}
export function useCommand(_userId: string, key: string, afterSuccess: (current: CurrentCommandGuard) => Promise<void> | void) {
  const { runtime } = useRuntime()
  const local = useLocalState(), sync = useSyncState()
  const mounted = useRef(true), sequence = useRef(0), inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++ } }, [])
  const [error, setError] = useState<Error | null>(null)
  const ownDraft = runtime.editors.get(key)?.()
  const pending = local.pending && (ownDraft ? local.pending.draftId === ownDraft.draftId : local.drafts.some(draft => draft.draftId === local.pending?.draftId && draft.key === key)) ? local.pending : null
  async function submit(command: Command, evidence?: { value: unknown; base: unknown }) {
    if (inFlight.current) return false
    inFlight.current = true
    const request = ++sequence.current
    const submitted = runtime.editors.get(key)?.()
    const current = () => mounted.current && sequence.current === request && runtime.current() && (!submitted || sameDraftRevision(runtime.editors.get(key)?.(), submitted))
    setError(null)
    try {
      const result = await runtime.submit(key, command, evidence)
      if (result.success && current()) {
        await afterSuccess(current)
        return current()
      }
      return false
    } catch (failure) { if (mounted.current && request === sequence.current && runtime.current()) setError(failure instanceof Error ? failure : new Error('Не удалось сохранить.')); return false }
    finally { inFlight.current = false }
  }
  async function retry() {
    try { setError(null); return await runtime.retry() } catch (failure) { if (mounted.current && runtime.current()) setError(failure as Error); return false }
  }
  const problem = error instanceof ApiError ? error.problem : pending?.problem
  return { pending, busy: local.busy, blocked: !!local.pending || !local.ready || !!local.storageError || sync.status !== 'ready', error, setError, submit, retry, problem, runtime }
}
const errorLabels: Record<string, string> = {
  occurrenceCompleted: 'Выполнение уже отмечено завершённым. Перечитайте его состояние; для изменения сначала снимите отметку.',
  completionMismatch: 'Активная отметка изменилась. Старое намерение отмены сохранено и не применяется к новой отметке. Обновите состояние и выберите новое действие явно.',
  staleEntity: 'Эта запись изменилась в другой вкладке. Ваш ввод сохранён.',
  staleDefinition: 'Описание задачи изменилось. Проверьте новые условия перед созданием выполнения.',
  staleSchedule: 'Расписание изменилось. Обновите календарь перед повторным действием.',
  fixedChangeRequiresConfirmation: 'Для этого изменения требуется отдельное подтверждение фиксации.',
  placementConflict: 'Выбранное время пересекается с другим выполнением.',
  invalidExistingPlacement: 'Новые условия несовместимы с текущим блоком. Сначала явно снимите его с календаря.',
  invalidLocalTime: 'Это локальное время не существует из-за перевода часов. Выберите другое время.',
  invalidUtcOffset: 'Выберите действительный UTC offset для этого локального времени.',
  ambiguousAvailabilityBoundary: 'Граница разрешённого окна неоднозначна. Добавьте исключение на эту дату с явными UTC offset.',
  outsideAvailability: 'Полный объём не помещается в разрешённые окна.',
  invalidCursor: 'Список изменился или курсор устарел. Обновите список.',
  unauthorized: 'Сеанс истёк. Войдите снова; ваш ввод сохранён для прежнего аккаунта.',
  invalidCredentials: 'Не удалось войти. Проверьте имя и пароль или попробуйте позже.',
  idempotencyMismatch: 'Сервер отклонил повтор с изменёнными данными. Обновите базу и создайте новую попытку.',
  unsupportedConstraint: 'Условия выходят за возможности текущего этапа. Ввод сохранён.',
}
const fieldLabels: Record<string, string> = { title: 'Название', description: 'Описание', categoryId: 'Категория', importance: 'Важность', difficulty: 'Сложность', executionPriority: 'Приоритет', timezone: 'Часовой пояс', logicalDate: 'Дата выполнения', localStart: 'Начало', utcOffset: 'UTC offset', requiredWorkMinutes: 'Длительность', name: 'Название места или категории', windows: 'Разрешённые окна', dateExceptions: 'Исключения', startLocalTime: 'Начало окна', endLocalTime: 'Конец окна', daysOfWeek: 'Дни недели', mobilityPolicy: 'Фиксация' }
export function ErrorMessage({ error }: { error: Error | null }) {
  if (!error) return null
  const problem = error instanceof ApiError ? error.problem : undefined
  return <div className="notice notice--error" role="alert"><p>{problem ? errorLabels[problem.code] ?? problem.detail ?? problem.title : error.message}</p>{problem?.fieldErrors && <ul>{Object.entries(problem.fieldErrors).flatMap(([path, messages]) => messages.map((message, index) => <li key={`${path}:${index}`}>{fieldLabels[path.split('.').at(-1) ?? ''] ?? 'Поле формы'}: {message}</li>))}</ul>}{problem?.correlationId && <details><summary>Код обращения</summary><span>{problem.correlationId}</span></details>}</div>
}
export function CommandStatus({ command }: { command: ReturnType<typeof useCommand> }) {
  return <><ErrorMessage error={command.error} />{command.pending && !command.busy && <p className="notice" role="status">Для этой формы сохранена отправка. Управление и восстановление доступны в разделе «Сохранённое в браузере». Текущий ввод можно продолжать менять; отправленные данные останутся прежними.</p>}</>
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}
export function Panel({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{onClose && <button className="text-button" type="button" onClick={onClose}>Закрыть</button>}</div>{children}</section>
}
export function ConflictReview({ current, draft, onAccept, onCancel }: { current: ReactNode; draft: ReactNode; onAccept: () => void; onCancel: () => void }) {
  return <section className="conflict-review" aria-label="Сравнение перед обновлением базы"><h3>Проверьте обе редакции</h3><p>После выбора новой базы полный ввод формы заменит редактируемые поля при следующем сохранении. Ввод остаётся прежним; сохранение выполняется отдельным действием.</p><div className="comparison-grid"><div><h4>Сейчас на сервере</h4>{current}</div><div><h4>Ваш ввод / исходные условия</h4>{draft}</div></div><div className="actions"><button type="button" onClick={onAccept}>Использовать эту редакцию как базу</button><button type="button" className="text-button" onClick={onCancel}>Продолжить без обновления базы</button></div></section>
}
export function canRebase(problem?: ProblemDetails) { return !!problem && ['staleEntity', 'staleDefinition', 'staleSchedule', 'idempotencyMismatch', 'preconditionRequired'].includes(problem.code) }
export function SubmitButton({ busy, disabled = false, children = 'Сохранить' }: { busy: boolean; disabled?: boolean; children?: ReactNode }) { return <button className="primary" type="submit" disabled={busy || disabled}>{busy ? 'Сохраняем…' : children}</button> }

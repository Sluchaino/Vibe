import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, mutate } from '../api/client'
import type { ProblemDetails } from '../api/types'
import { captureCommand, type Command, type PendingCommand } from '../lib/operations'
import { identityState } from '../state/session'
import { openDraft, rebaseDraft, type VersionedDraft } from '../lib/drafts'
import { CommandLifecycle, settleAcknowledgement, type CurrentCommandGuard } from '../lib/command-lifecycle'

export function useDraft<T>(userId: string, key: string, initial: T) {
  const [draft, setState] = useState<T>(() => identityState.getDraft<T>(userId, key) ?? structuredClone(initial))
  function setDraft(next: T | ((previous: T) => T)) {
    setState(previous => { const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next; identityState.setDraft(userId, key, value); return value })
  }
  function clear() { identityState.clearDraft(userId, key) }
  return [draft, setDraft, clear] as const
}
export function useVersionedDraft<Value, Base>(userId: string, key: string, initial: Value, currentBase: Base) {
  const storageKey = `versioned:${key}`
  const [draft, setState] = useState(() => {
    const restored = openDraft(identityState.getDraft<VersionedDraft<Value, Base>>(userId, storageKey), initial, currentBase)
    identityState.setDraft(userId, storageKey, restored)
    return restored
  })
  function update(value: Value) {
    setState(previous => { const next = { ...previous, value }; identityState.setDraft(userId, storageKey, next); return next })
  }
  function rebase(base: Base) {
    setState(previous => { const next = rebaseDraft(previous, base); identityState.setDraft(userId, storageKey, next); return next })
  }
  function clear() { identityState.clearDraft(userId, storageKey) }
  return { value: draft.value, base: draft.base, update, rebase, clear }
}
export function useCommand(userId: string, key: string, afterSuccess: (current: CurrentCommandGuard) => Promise<void> | void) {
  const storageKey = `pending:${key}`
  const lifecycleRef = useRef<CommandLifecycle | null>(null)
  if (!lifecycleRef.current) lifecycleRef.current = new CommandLifecycle(userId, storageKey, identityState)
  const lifecycle = lifecycleRef.current
  useEffect(() => { lifecycle.mount(); return () => lifecycle.unmount() }, [lifecycle])
  const [pending, setPending] = useState<PendingCommand | null>(() => identityState.getDraft<PendingCommand>(userId, storageKey) ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  async function deliver(command: PendingCommand) {
    const ticket = lifecycle.begin(command)
    if (!ticket) return false
    const current = () => lifecycle.current(ticket)
    setBusy(true); setError(null)
    try { await mutate(command) } catch (failure) {
      const err = failure instanceof Error ? failure : new Error('Не удалось сохранить изменения.')
      lifecycle.fail(ticket, err)
      if (current()) { setPending(lifecycle.stored() ?? null); setError(err); setBusy(false) }
      lifecycle.end(ticket)
      return false
    }
    const result = await settleAcknowledgement(lifecycle, ticket, afterSuccess, () => setPending(null))
    if (result.current) {
      if (result.refreshError) setError(new Error('Изменения сохранены. Не удалось обновить отображение; нажмите «Обновить». До обновления показана прежняя редакция.'))
      setBusy(false)
    }
    lifecycle.end(ticket)
    return result.success
  }
  async function submit(command: Command) {
    if (lifecycle.inFlight) return false
    if (lifecycle.stored()) { setError(new Error('Сначала повторите отправку незавершённой операции. Изменённый ввод останется в форме.')); return false }
    const captured = captureCommand(userId, command)
    setPending(captured)
    return deliver(captured)
  }
  return { pending, busy, error, setError, submit, retry: () => pending ? deliver(pending) : Promise.resolve(false), problem: error instanceof ApiError ? error.problem : undefined }
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
  return <><ErrorMessage error={command.error} />{command.pending && !command.busy && <div className="notice"><p>Отправленная операция ещё не подтверждена. Повтор использует те же данные; текущий ввод в форме сохранён.</p><button type="button" onClick={() => void command.retry()}>Повторить отправку</button></div>}</>
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
export function SubmitButton({ busy, children = 'Сохранить' }: { busy: boolean; children?: ReactNode }) { return <button className="primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : children}</button> }

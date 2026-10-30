import { useState } from 'react'
import type { DraftRecord } from '../persistence/database'
import { draftCategory, recoveryDraft } from '../persistence/database'
import { sameData } from '../lib/durable-draft'
import { useLocalState, useRuntime, useSyncState } from '../sync/context'
import { pendingLabels } from '../sync/runtime'
import { ErrorMessage } from './shared'
import { ConstraintSummary, DefinitionSummary, OccurrenceSummary, SettingsSummary, definitionSummaryValue } from './RecordSummary'
import { constraintDraft } from './ConstraintsForm'
import type { ConstraintsSnapshot, TaskDefinition, TaskOccurrence } from '../api/types'
import type { RecurrenceRule, TimeIntent } from '../api/types'
import { RecurrenceSummary } from './RecurrenceFields'
import { weekdays } from './AvailabilityForm'

export function draftLabel(key: string) {
  if (key === 'settings') return 'Место и часовой пояс'
  if (key === 'new-category') return 'Новая категория'
  if (key === 'new-task') return 'Новая задача'
  if (key.startsWith('task-create:')) return 'Продолжение создания задачи'
  if (key === 'new-definition') return 'Новая задача'
  if (key === 'new-recurring-definition') return 'Новая повторяющаяся задача'
  if (key.startsWith('recurring-create:')) return 'Продолжение создания повторения'
  if (key.startsWith('create-recurrence:')) return 'Настройки нового повторения'
  if (key.startsWith('recurrence-stop:')) return 'Остановка повторения'
  if (key.startsWith('calendar-create:')) return 'Продолжить создание задачи для календаря'
  if (key.startsWith('creation-start:')) return 'Выбранное начало выполнения'
  if (key.startsWith('definition:')) return 'Описание задачи'
  if (key.startsWith('create-occurrence:')) return 'Новое выполнение'
  if (key.startsWith('occurrence:')) return 'Условия выполнения'
  if (key.startsWith('placement:')) return 'Размещение выполнения'
  return 'Отметка выполнения'
}
export function LocalRecovery({ onRestore, onCleared }: { onRestore: (record: DraftRecord) => void; onCleared: () => void }) {
  const { runtime } = useRuntime(), local = useLocalState(), sync = useSyncState()
  const [error, setError] = useState<Error | null>(null), [clearConfirmed, setClearConfirmed] = useState(false)
  const pending = local.pending
  const groups = [
    { kind: 'manual', title: 'Сохранённые черновики', button: 'Редактировать черновик' },
    { kind: 'emergency', title: 'Аварийное восстановление и отправленные снимки', button: 'Восстановить ввод' },
    { kind: 'continuation', title: 'Продолжения создания', button: 'Продолжить создание' },
  ]
  const currentDraft = local.drafts.find(draft => draft.sourceDraftId === pending?.draftId && !draft.pendingOpId) ?? local.drafts.find(draft => draft.draftId === pending?.draftId)
  const submitted = pending?.submittedDraft
  const newerInput = currentDraft && submitted && (!sameData(currentDraft.value, submitted.value) || !sameData(currentDraft.base, submitted.base))
  async function run(action: () => Promise<unknown>) { setError(null); try { await action() } catch (failure) { setError(failure as Error) } }
  const input = pending?.command.body
  const sentTiming = input?.timeIntent && typeof input.timeIntent === 'object' ? input.timeIntent as TimeIntent : null
  const sourceTitle = submitted?.value && typeof submitted.value === 'object' ? (submitted.value as { title?: unknown }).title : undefined
  const confirmed = sync.projection
  const settings = confirmed?.settings
  const occurrenceId = pending?.command.path.match(/^\/occurrences\/([^/]+)/)?.[1]
  const currentOccurrence = occurrenceId ? confirmed?.occurrences.get(occurrenceId.toLowerCase()) : undefined
  const definitionId = pending?.command.path.match(/^\/task-definitions\/([^/]+)/)?.[1]
  const currentDefinition = definitionId ? confirmed?.definitions.get(definitionId.toLowerCase()) : undefined
  const ruleId = pending?.command.path.match(/^\/recurrence-rules\/([^/]+)/)?.[1]
  const currentRule = ruleId ? confirmed?.recurrences.get(ruleId.toLowerCase()) : undefined
  return <details className="panel local-recovery" open={!!pending || !!local.storageError}>
    <summary>Сохранённое в браузере{pending ? ' · осталась отправка' : ` · черновиков: ${local.drafts.filter(draft => draftCategory(draft) === 'manual').length}`}</summary>
    <p className="muted">Сохранение обновляет выбранный черновик; простое открытие ничего не записывает. Аварийное восстановление хранится отдельно. Очистка данных браузера может удалить локальный ввод.</p>
    <ErrorMessage error={local.storageError ?? error} />
    {local.storageError && <button type="button" onClick={() => void run(() => runtime.retryStorage())}>Повторить локальное сохранение</button>}
    {pending && <section className="notice" aria-label="Оставшаяся отправка"><h3>{pendingLabels[pending.status]}</h3>
      <p>{draftLabel(submitted?.key ?? 'completion:')} · {pending.command.path.endsWith('/reopen') ? 'Снять выбранную ранее отметку' : input?.action === 'unplace' ? 'Снять блок с календаря' : input?.action === 'move' ? 'Перенести блок' : input?.action === 'place' ? 'Разместить выполнение' : input?.action === 'setFixed' ? 'Изменить фиксацию' : pending.command.path.endsWith('/completion') ? 'Отметить выполненным' : 'Сохранить введённые изменения'}.</p>
      {typeof input?.localStart === 'string' && <p>Выбранное начало: {input.localStart.replace('T', ' ')} · {String(input.timezone)} · {String(input.utcOffset)}</p>}
      {typeof input?.logicalDate === 'string' && <p>Дата выполнения: {input.logicalDate}</p>}
      <div className="comparison-grid"><section aria-label="Первоначально отправлено"><h4>Первоначально отправлено</h4>
        {typeof input?.title !== 'string' && typeof sourceTitle === 'string' && <h5>{sourceTitle}</h5>}
        {sentTiming && <p>Выбранные часы: {sentTiming.startLocalTime ?? 'начало не задано'} — {sentTiming.endLocalTime ?? 'конец не задан'}{sentTiming.endDayOffset > 0 && ` · конец через ${sentTiming.endDayOffset} дн.`} · {sentTiming.timezone}. {sentTiming.startDisambiguation && `Начало: ${sentTiming.startDisambiguation === 'earlier' ? 'раннее' : 'позднее'} вхождение.`} {sentTiming.endDisambiguation && `Конец: ${sentTiming.endDisambiguation === 'earlier' ? 'раннее' : 'позднее'} вхождение.`}</p>}
        {input?.pattern === 'interval' && <p>Повторять через каждые {String(input.intervalDays)} дн. от {String(input.anchorDate)}{input.endDate ? ` по ${String(input.endDate)} включительно` : ' без окончания'} · {String(input.timezone)}. Созданные выполнения и возможный отказ занять время проверяются по свежему состоянию.</p>}
        {input?.pattern === 'weekly' && <p>Повторять {weekdays.filter(day => (input.daysOfWeek as string[]).includes(day.value)).map(day => day.label).join(', ')} · с {String(input.startDate)}{input.endDate ? ` по ${String(input.endDate)}` : ' без окончания'} · {String(input.timezone)}. {input.timeIntent ? "Общие часы разрешаются на каждой дате; блок создаётся только при успешной проверке." : "Без общих часов время не занимается."}</p>}
        {ruleId && !!submitted?.base && <><p>Остановить создание новых выполнений; уже созданные сохраняются.</p><RecurrenceSummary rule={submitted.base as RecurrenceRule} /></>}
        {typeof input?.name === 'string' && <p>Название категории: {input.name}</p>}
        {!!input?.place && typeof input.place === 'object' && <SettingsSummary timezone={String(input.timezone)} name={String((input.place as { name: string }).name)} />}
        {typeof input?.title === 'string' && <><h5>{input.title}</h5><p>{String(input.description ?? '')}</p><p>Важность: {({ low: 'низкая', normal: 'обычная', high: 'высокая' } as Record<string, string>)[String(input.importance)]} · Сложность: {({ light: 'лёгкая', medium: 'средняя', heavy: 'тяжёлая' } as Record<string, string>)[String(input.difficulty)]} · Приоритет: {String(input.executionPriority)}</p></>}
        {(!!input?.durationPolicy || typeof input?.workOrigin === "string") && <ConstraintSummary value={constraintDraft(input as unknown as ConstraintsSnapshot)} placeName={settings?.place?.name ?? 'Сохранённое место'} />}
        {!!input?.constraintsSnapshot && <ConstraintSummary value={constraintDraft(input.constraintsSnapshot as ConstraintsSnapshot)} placeName={settings?.place?.name ?? 'Сохранённое место'} />}
        {typeof input?.definitionVersion === 'string' && !!submitted?.base && <DefinitionSummary value={definitionSummaryValue(submitted.base as TaskDefinition)} categories={confirmed ? [...confirmed.categories.values()] : []} placeName={settings?.place?.name ?? 'Сохранённое место'} />}
        {input?.action === 'setFixed' && <p>{input.fixed ? 'Закрепить блок' : 'Снять фиксацию блока'}</p>}
        {pending.command.path.endsWith('/reopen') && !!submitted?.base && <p>Снять отметку, выбранную при отправке{(submitted.base as TaskOccurrence).completion ? ` (${new Date((submitted.base as TaskOccurrence).completion!.completedAt).toLocaleString('ru-RU', { timeZone: settings?.timezone ?? 'UTC' })})` : ''}. Новая отметка вместо неё не выбирается.</p>}
      </section><section aria-label="Свежая подтверждённая редакция"><h4>Свежая подтверждённая редакция</h4>
        {currentRule && <RecurrenceSummary rule={currentRule} />}
        {sync.status !== 'ready' && <p>Данные требуют обновления.</p>}
        {currentOccurrence && settings ? <OccurrenceSummary occurrence={currentOccurrence} settings={settings} /> : currentDefinition ? <DefinitionSummary value={definitionSummaryValue(currentDefinition)} categories={confirmed ? [...confirmed.categories.values()] : []} placeName={settings?.place?.name ?? 'Не задано'} /> : pending.command.path === '/settings' && settings ? <SettingsSummary timezone={settings.timezone} name={settings.place?.name ?? ''} /> : <p>Серверные данные доступны в соответствующем разделе планировщика.</p>}
      </section></div>
      {newerInput && <p>После отправки вы продолжили редактирование. Ниже сохранён более новый ввод; первоначальная отправка остаётся прежней.</p>}
      {pending.status === 'unconfirmed' && <p>Результат отправки пока неизвестен. Повтор использует первоначальные данные. Нельзя заменить эту отправку новой; изменённый ввод хранится отдельно.</p>}
      {pending.status === 'acknowledgedRefresh' && <p>Сервер подтвердил отправку. Остаётся получить свежие данные; повторная команда не отправляется.</p>}
      {pending.status === 'resetReview' && <p>Источник данных был восстановлен. Прежний результат мог измениться. Сначала просмотрите свежие данные и сохранённый ввод. Повтор отправит исходное действие с исходными условиями; новая отметка не заменит выбранную ранее.</p>}
      {pending.problem && <ErrorMessage error={new Error(pending.problem.detail || pending.problem.title)} />}
      <div className="actions">
        {(pending.status === 'unconfirmed' || pending.status === 'acknowledgedRefresh') && <button type="button" disabled={local.busy || sync.status !== 'ready'} onClick={() => void run(() => runtime.retry())}>{pending.status === 'acknowledgedRefresh' ? 'Обновить после сохранения' : 'Повторить исходную отправку'}</button>}
        {pending.status === 'resetReview' && <button type="button" disabled={local.busy || sync.status !== 'ready'} onClick={() => void run(() => runtime.retry(true))}>Повторить исходную отправку после проверки</button>}
        {submitted && pending && <button type="button" onClick={() => onRestore(recoveryDraft({ ...pending, recoveryDraftId: pending.recoveryDraftId ?? `pending:${pending.opId}`, recoveryRevision: pending.recoveryRevision ?? 1 }, submitted))}>Открыть первоначальный ввод</button>}
        {currentDraft && newerInput && <button type="button" onClick={() => onRestore(currentDraft)}>Открыть более новый ввод</button>}
        {(pending.status === 'conflict' || pending.status === 'rejected') && <button type="button" disabled={local.busy || sync.status !== 'ready'} onClick={() => void run(() => runtime.resolveRejection())}>Разрешить отказ, сохранить ввод</button>}
      </div>
      {(pending.status === 'conflict' || pending.status === 'rejected') && <p>После разрешения отказа черновик останется. В форме явно сравните редакции и выберите базу; новое сохранение будет отдельной попыткой.</p>}
    </section>}
    {groups.map(group => <section key={group.kind}><h3>{group.title}</h3><ul className="saved-drafts">{local.drafts.filter(draft => draftCategory(draft) === group.kind).map(draft => { const value = draft.value as Record<string, unknown> | null; return <li key={draft.draftId}><span>{draftLabel(draft.key)}{typeof value?.title === 'string' && value.title ? ` · ${value.title}` : ''}{typeof value?.name === 'string' && value.name ? ` · ${value.name}` : ''} <small>{new Date(draft.updatedAt).toLocaleString('ru-RU')}</small></span><button type="button" onClick={() => onRestore(draft)}>{group.button}</button></li> })}</ul></section>)}
    <label className="confirmation"><input type="checkbox" checked={clearConfirmed} onChange={event => setClearConfirmed(event.target.checked)} />Удалить локальные черновики этого аккаунта на этом адресе. Серверные данные сохранятся.</label>
    <button type="button" disabled={!clearConfirmed || !!pending || local.busy || !local.ready} onClick={() => void run(async () => { if (await runtime.requestLeave(() => runtime.clearAccount())) { setClearConfirmed(false); onCleared() } })}>Очистить локальные данные аккаунта</button>
    {pending && <p className="muted">Очистка доступна после разрешения оставшейся отправки.</p>}
  </details>
}

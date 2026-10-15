import { useState } from 'react'
import type { DraftRecord } from '../persistence/database'
import { useLocalState, useRuntime, useSyncState } from '../sync/context'
import { pendingLabels } from '../sync/runtime'
import { ErrorMessage } from './shared'
import { ConstraintSummary, DefinitionSummary, OccurrenceSummary, SettingsSummary, definitionSummaryValue } from './RecordSummary'
import { constraintDraft } from './ConstraintsForm'
import type { ConstraintsSnapshot, TaskDefinition, TaskOccurrence } from '../api/types'

export function draftLabel(key: string) {
  if (key === 'settings') return 'Место и часовой пояс'
  if (key === 'new-category') return 'Новая категория'
  if (key === 'new-definition') return 'Новая задача'
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
  const currentDraft = local.drafts.find(draft => draft.draftId === pending?.draftId)
  const submitted = pending?.submittedDraft
  async function run(action: () => Promise<unknown>) { setError(null); try { await action() } catch (failure) { setError(failure as Error) } }
  const input = pending?.command.body
  const confirmed = sync.projection
  const settings = confirmed?.settings
  const occurrenceId = pending?.command.path.match(/^\/occurrences\/([^/]+)/)?.[1]
  const currentOccurrence = occurrenceId ? confirmed?.occurrences.get(occurrenceId.toLowerCase()) : undefined
  const definitionId = pending?.command.path.match(/^\/task-definitions\/([^/]+)/)?.[1]
  const currentDefinition = definitionId ? confirmed?.definitions.get(definitionId.toLowerCase()) : undefined
  return <details className="panel local-recovery" open={!!pending || !!local.storageError}>
    <summary>Сохранённое в браузере{pending ? ' · осталась отправка' : ` · черновиков: ${local.drafts.length}`}</summary>
    <p className="muted">Черновики доступны после входа в этот аккаунт на этом адресе. Очистка данных браузера может удалить их. Восстановление открывает отдельную копию; ввод другой вкладки сохраняется.</p>
    <ErrorMessage error={local.storageError ?? error} />
    {local.storageError && <button type="button" onClick={() => void run(() => runtime.retryStorage())}>Повторить локальное сохранение</button>}
    {pending && <section className="notice" aria-label="Оставшаяся отправка"><h3>{pendingLabels[pending.status]}</h3>
      <p>{draftLabel(submitted?.key ?? 'completion:')} · {pending.command.path.endsWith('/reopen') ? 'Снять выбранную ранее отметку' : input?.action === 'unplace' ? 'Снять блок с календаря' : input?.action === 'move' ? 'Перенести блок' : input?.action === 'place' ? 'Разместить выполнение' : input?.action === 'setFixed' ? 'Изменить фиксацию' : pending.command.path.endsWith('/completion') ? 'Отметить выполненным' : 'Сохранить введённые изменения'}.</p>
      {typeof input?.localStart === 'string' && <p>Выбранное начало: {input.localStart.replace('T', ' ')} · {String(input.timezone)} · {String(input.utcOffset)}</p>}
      {typeof input?.logicalDate === 'string' && <p>Дата выполнения: {input.logicalDate}</p>}
      <div className="comparison-grid"><section aria-label="Первоначально отправлено"><h4>Первоначально отправлено</h4>
        {typeof input?.name === 'string' && <p>Название категории: {input.name}</p>}
        {!!input?.place && typeof input.place === 'object' && <SettingsSummary timezone={String(input.timezone)} name={String((input.place as { name: string }).name)} />}
        {typeof input?.title === 'string' && <><h5>{input.title}</h5><p>{String(input.description ?? '')}</p><p>Важность: {({ low: 'низкая', normal: 'обычная', high: 'высокая' } as Record<string, string>)[String(input.importance)]} · Сложность: {({ light: 'лёгкая', medium: 'средняя', heavy: 'тяжёлая' } as Record<string, string>)[String(input.difficulty)]} · Приоритет: {String(input.executionPriority)}</p></>}
        {!!input?.durationPolicy && <ConstraintSummary value={constraintDraft(input as unknown as ConstraintsSnapshot)} placeName={settings?.place?.name ?? 'Сохранённое место'} />}
        {!!input?.constraintsSnapshot && <ConstraintSummary value={constraintDraft(input.constraintsSnapshot as ConstraintsSnapshot)} placeName={settings?.place?.name ?? 'Сохранённое место'} />}
        {typeof input?.definitionVersion === 'string' && !!submitted?.base && <DefinitionSummary value={definitionSummaryValue(submitted.base as TaskDefinition)} categories={confirmed ? [...confirmed.categories.values()] : []} placeName={settings?.place?.name ?? 'Сохранённое место'} />}
        {input?.action === 'setFixed' && <p>{input.fixed ? 'Закрепить блок' : 'Снять фиксацию блока'}</p>}
        {pending.command.path.endsWith('/reopen') && !!submitted?.base && <p>Снять отметку, выбранную при отправке{(submitted.base as TaskOccurrence).completion ? ` (${new Date((submitted.base as TaskOccurrence).completion!.completedAt).toLocaleString('ru-RU', { timeZone: settings?.timezone ?? 'UTC' })})` : ''}. Новая отметка вместо неё не выбирается.</p>}
      </section><section aria-label="Свежая подтверждённая редакция"><h4>Свежая подтверждённая редакция</h4>
        {sync.status !== 'ready' && <p>Данные требуют обновления.</p>}
        {currentOccurrence && settings ? <OccurrenceSummary occurrence={currentOccurrence} settings={settings} /> : currentDefinition ? <DefinitionSummary value={definitionSummaryValue(currentDefinition)} categories={confirmed ? [...confirmed.categories.values()] : []} placeName={settings?.place?.name ?? 'Не задано'} /> : pending.command.path === '/settings' && settings ? <SettingsSummary timezone={settings.timezone} name={settings.place?.name ?? ''} /> : <p>Серверные данные доступны в соответствующем разделе планировщика.</p>}
      </section></div>
      {currentDraft && submitted && currentDraft.revision !== submitted.revision && <p>После отправки вы продолжили редактирование. Ниже сохранён более новый ввод; первоначальная отправка остаётся прежней.</p>}
      {pending.status === 'unconfirmed' && <p>Результат отправки пока неизвестен. Повтор использует первоначальные данные. Нельзя заменить эту отправку новой; изменённый ввод хранится отдельно.</p>}
      {pending.status === 'acknowledgedRefresh' && <p>Сервер подтвердил отправку. Остаётся получить свежие данные; повторная команда не отправляется.</p>}
      {pending.status === 'resetReview' && <p>Источник данных был восстановлен. Прежний результат мог измениться. Сначала просмотрите свежие данные и сохранённый ввод. Повтор отправит исходное действие с исходными условиями; новая отметка не заменит выбранную ранее.</p>}
      {pending.problem && <ErrorMessage error={new Error(pending.problem.detail || pending.problem.title)} />}
      <div className="actions">
        {(pending.status === 'unconfirmed' || pending.status === 'acknowledgedRefresh') && <button type="button" disabled={local.busy || sync.status !== 'ready'} onClick={() => void run(() => runtime.retry())}>{pending.status === 'acknowledgedRefresh' ? 'Обновить после сохранения' : 'Повторить исходную отправку'}</button>}
        {pending.status === 'resetReview' && <button type="button" disabled={local.busy || sync.status !== 'ready'} onClick={() => void run(() => runtime.retry(true))}>Повторить исходную отправку после проверки</button>}
        {submitted && <button type="button" onClick={() => onRestore(submitted)}>Открыть первоначальный ввод</button>}
        {currentDraft && submitted && currentDraft.revision !== submitted.revision && <button type="button" onClick={() => onRestore(currentDraft)}>Открыть более новый ввод</button>}
        {(pending.status === 'conflict' || pending.status === 'rejected') && <button type="button" disabled={local.busy || sync.status !== 'ready'} onClick={() => void run(() => runtime.resolveRejection())}>Разрешить отказ, сохранить ввод</button>}
      </div>
      {(pending.status === 'conflict' || pending.status === 'rejected') && <p>После разрешения отказа черновик останется. В форме явно сравните редакции и выберите базу; новое сохранение будет отдельной попыткой.</p>}
    </section>}
    <ul className="saved-drafts">{local.drafts.map(draft => { const value = draft.value as Record<string, unknown> | null; return <li key={draft.draftId}><span>{draftLabel(draft.key)}{typeof value?.title === 'string' && value.title ? ` · ${value.title}` : ''}{typeof value?.name === 'string' && value.name ? ` · ${value.name}` : ''} <small>{new Date(draft.updatedAt).toLocaleString('ru-RU')}</small></span><button type="button" onClick={() => onRestore(draft)}>Восстановить черновик</button></li> })}</ul>
    <label className="confirmation"><input type="checkbox" checked={clearConfirmed} onChange={event => setClearConfirmed(event.target.checked)} />Удалить локальные черновики этого аккаунта на этом адресе. Серверные данные сохранятся.</label>
    <button type="button" disabled={!clearConfirmed || !!pending || local.busy || !local.ready} onClick={() => void run(async () => { await runtime.clearAccount(); setClearConfirmed(false); onCleared() })}>Очистить локальные данные аккаунта</button>
    {pending && <p className="muted">Очистка доступна после разрешения оставшейся отправки.</p>}
  </details>
}

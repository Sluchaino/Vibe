import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError, login, logout, resetTransport, restoreSession, setExpiredHandler } from './api/client'
import type { MeResponse, OccurrenceResponse, PlanState, TaskDefinition, TaskOccurrence } from './api/types'
import { Calendar } from './components/Calendar'
import { CompletionForm } from './components/CompletionForm'
import { CategoryForm } from './components/CategoryForm'
import { supportedConstraints } from './components/ConstraintsForm'
import { DefinitionForm } from './components/DefinitionForm'
import { CreateOccurrenceForm, OccurrenceForm } from './components/OccurrenceForm'
import { PlacementForm } from './components/PlacementForm'
import { SettingsForm } from './components/SettingsForm'
import { ErrorMessage, Field, Panel, SubmitButton } from './components/shared'
import { effectiveFixed } from './lib/operations'
import { addDays, calendarRange, completionTimeLabel, dateLabel, instantLabel, today } from './lib/time'
import { hasCurrentCompletion, isCompleted, type CompletionFilter } from './lib/completion'
import { identityState } from './state/session'

import { AccountRuntime } from './sync/runtime'
import { RuntimeContext, useLocalState, useRuntime, useSyncState } from './sync/context'
import { selectCalendar, selectOccurrences, sorted, pageItems } from './sync/projection'
import type { DraftRecord } from './persistence/database'
import { LocalRecovery } from './components/LocalRecovery'
import { selectRestoration, type RestorationSelection } from './lib/durable-draft'
const importanceLabels = { low: 'Низкая', normal: 'Обычная', high: 'Высокая' }
const difficultyLabels = { light: 'Лёгкая', medium: 'Средняя', heavy: 'Тяжёлая' }
function asError(error: unknown) { return error instanceof Error ? error : new Error('Не удалось получить данные.') }
function usePage<T>(items: T[], key: string) {
  const [paging, setPaging] = useState({ key, count: 50 })
  useEffect(() => { setPaging({ key, count: 50 }) }, [key])
  const count = paging.key === key ? paging.count : 50
  const page = pageItems(items, count)
  return { page: { items: page.items, nextCursor: page.hasMore ? 'more' : null }, error: null, busy: false, more: () => setPaging({ key, count: count + 50 }) }
}
function LoadMore({ cursor, busy, onLoad }: { cursor?: string | null; busy: boolean; onLoad: () => void }) { return cursor ? <button className="load-more" type="button" disabled={busy} onClick={onLoad}>{busy ? 'Загружаем…' : 'Показать ещё'}</button> : null }
function supportedDefinition(value: TaskDefinition) {
  const known = ['id', 'serverVersion', 'title', 'description', 'categoryId', 'importance', 'difficulty', 'executionPriority', 'durationPolicy', 'splitAllowed', 'mobilityPolicy', 'availabilityRules', 'placeId', 'requiredRestMinutes']
  const snapshot = { durationPolicy: value.durationPolicy, splitAllowed: value.splitAllowed, mobilityPolicy: value.mobilityPolicy, availabilityRules: value.availabilityRules, placeId: value.placeId, requiredRestMinutes: value.requiredRestMinutes }
  return known.every(key => key in value) && Object.keys(value).every(key => known.includes(key)) && supportedConstraints(snapshot)
}
function OccurrenceCard({ occurrence, definition, timezone, refreshRequired, onEdit, onPlace, onComplete }: { occurrence: TaskOccurrence; definition?: TaskDefinition; timezone: string; refreshRequired: boolean; onEdit: () => void; onPlace: () => void; onComplete: () => void }) {
  const completed = isCompleted(occurrence)
  return <article className={`occurrence-card ${completed ? 'occurrence-card--done' : ''}`}><div><h3>{definition?.title ?? 'Выполнение'}</h3><p className="muted">Дата выполнения: {occurrence.logicalDate} · Объём: {occurrence.constraintsSnapshot.durationPolicy.requiredWorkMinutes} мин · Остаток: {occurrence.remainingWorkMinutes} мин</p><span className={`status-pill ${completed ? 'status-pill--done' : ''}`}>{completed ? 'Выполнено' : 'Не выполнено'}</span>{occurrence.completion && <p className="completion-time">Отмечено {completionTimeLabel(occurrence.completion.completedAt, timezone)}</p>}{definition && <p className="metadata">Важность: {importanceLabels[definition.importance]} · Сложность: {difficultyLabels[definition.difficulty]} · Приоритет: {definition.executionPriority}</p>}{occurrence.calendarBlock ? <p className="block-summary">{instantLabel(occurrence.calendarBlock.startInstant, timezone)} — {instantLabel(occurrence.calendarBlock.endInstant, timezone)}{effectiveFixed(occurrence) && ' · закреплено'}</p> : <span className="status-pill">Не запланировано</span>}</div><div className="actions"><button type="button" className="primary" onClick={onComplete}>{completed ? 'Снять отметку' : 'Отметить выполненным'}</button><button type="button" onClick={onPlace} disabled={completed || refreshRequired}>{occurrence.calendarBlock ? 'Изменить размещение' : 'В календарь'}</button><button type="button" className="text-button" onClick={onEdit}>{completed ? 'Просмотреть условия' : 'Условия выполнения'}</button></div></article>
}

type Editor = ({ kind: 'definition'; definition?: TaskDefinition } | { kind: 'occurrence' | 'placement' | 'completion'; occurrence: TaskOccurrence; definition: TaskDefinition; planState: PlanState }) & { editorId: string }
function Workspace({ me }: { me: MeResponse }) {
  const [runtime, setRuntime] = useState<AccountRuntime | null>(null)
  const [restoration, setRestoration] = useState<RestorationSelection | null>(null)
  function setRestore(record: DraftRecord | null) { const selected = record ? selectRestoration(record) : null; setRestoration(selected); return selected?.editorKey ?? '' }
  const [localGeneration, setLocalGeneration] = useState(0)
  useEffect(() => {
    const active = new AccountRuntime(me.userId)
    setRuntime(active); void active.start()
    return () => active.stop()
  }, [me.userId])
  return runtime ? <RuntimeContext.Provider value={{ runtime, restore: restoration?.record ?? null, restoreKey: restoration?.editorKey ?? '' }}><WorkspaceContent key={localGeneration} me={me} setRestore={setRestore} onCleared={() => { setRestore(null); setLocalGeneration(value => value + 1) }} /></RuntimeContext.Provider> : <main id="main-content"><p role="status">Подключаем данные аккаунта…</p></main>
}
function WorkspaceContent({ me, setRestore, onCleared }: { me: MeResponse; setRestore: (draft: DraftRecord | null) => string; onCleared: () => void }) {
  const { runtime, restore, restoreKey } = useRuntime(), sync = useSyncState(), local = useLocalState()
  const projection = sync.projection
  const settings = projection?.settings
  const [tab, setTab] = useState<'calendar' | 'tasks' | 'settings'>('calendar')
  const [view, setView] = useState<'day' | 'week'>('week')
  const [date, setDate] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [editorState, setEditor] = useState<Editor | null>(null)
  const [selected, setSelectedDefinition] = useState<TaskDefinition | null>(null)
  const selectedDefinition = selected ? projection?.definitions.get(selected.id) ?? null : null
  const [notice, setNotice] = useState('')
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter>('all')
  const busy = sync.busy
  const refreshRequired = sync.status !== 'ready' || local.pending?.status === 'acknowledgedRefresh' || local.pending?.status === 'resetReview'
  const categories = usePage(projection ? sorted(projection.categories.values()) : [], 'categories')
  const definitions = usePage(projection ? sorted(projection.definitions.values()) : [], 'definitions')
  const unplanned = usePage(projection ? selectOccurrences(projection, 'incomplete', undefined, true) : [], 'unplanned')
  const executions = usePage(projection ? selectOccurrences(projection, completionFilter, selectedDefinition?.id) : [], `${completionFilter}:${selectedDefinition?.id ?? ''}`)
  const editorElement = useRef<HTMLDivElement>(null)
  const metadata = { current: projection?.definitions ?? new Map<string, TaskDefinition>() }
  const range = useMemo(() => { if (!settings || !date) return null; try { return calendarRange(date, view, settings.timezone) } catch (failure) { return { error: asError(failure) } } }, [date, view, settings?.timezone])
  const validRange = range && !('error' in range) ? range : null
  const calendar = projection && validRange ? selectCalendar(projection, validRange.from, validRange.to) : null
  const editor: Editor | null = editorState && projection ? (editorState.kind === 'definition'
    ? { ...editorState, definition: editorState.definition ? projection.definitions.get(editorState.definition.id) ?? editorState.definition : undefined }
    : { ...editorState, occurrence: projection.occurrences.get(editorState.occurrence.id) ?? editorState.occurrence, definition: projection.definitions.get(editorState.definition.id) ?? editorState.definition, planState: projection.planState }) : null
  useEffect(() => { if (settings) setDate(previous => previous || today(settings.timezone)) }, [settings?.timezone])
  useEffect(() => { if (editorState) { editorElement.current?.scrollIntoView({ behavior: 'auto', block: 'start' }); editorElement.current?.focus() } }, [editorState])
  async function refresh() { setError(null); try { await runtime.coordinator.catchUp() } catch (failure) { setError(asError(failure)); throw failure } }
  async function saved() { setNotice('Изменения сохранены на сервере, состояние обновлено.') }
  async function refreshCompletion(id: string): Promise<OccurrenceResponse> {
    await runtime.coordinator.catchUp()
    const fresh = runtime.coordinator.snapshot().projection!
    const occurrence = fresh.occurrences.get(id)
    if (!occurrence) throw new Error('Выполнение больше недоступно.')
    return { occurrence, planState: fresh.planState }
  }
  async function openDefinition(definition?: TaskDefinition) {
    setRestore(null); setError(null)
    if (definition && !supportedDefinition(definition)) { setError(new Error('Для изменения этих условий обновите приложение.')); return }
    setEditor({ kind: 'definition', definition, editorId: crypto.randomUUID() })
  }
  async function openOccurrence(occurrence: TaskOccurrence, kind: 'occurrence' | 'placement' | 'completion') {
    setRestore(null); setError(null)
    const definition = projection?.definitions.get(occurrence.definitionId)
    if (!definition || !hasCurrentCompletion(occurrence) || !projection) { setError(new Error('Сначала дождитесь актуальных данных.')); return }
    setEditor({ kind, occurrence, definition, planState: projection.planState, editorId: crypto.randomUUID() })
  }
  async function selectDefinition(definition: TaskDefinition) { setRestore(null); setSelectedDefinition(definition); setEditor(null) }
  function navigateDate(days: number) { try { setDate(addDays(date, days)); setError(null) } catch (failure) { setError(asError(failure)) } }
  function restoreDraft(record: DraftRecord) {
    const restorationKey = setRestore(record)
    setEditor(null); setError(null); setNotice('Открыта отдельная копия черновика с исходной базой. Проверьте актуальную редакцию перед отправкой.')
    if (record.key === 'settings' || record.key === 'new-category') { setTab('settings'); return }
    setTab('tasks')
    const [kind, id] = record.key.split(':')
    if (kind === 'create-occurrence') { const definition = projection?.definitions.get(id!); if (definition) setSelectedDefinition(definition); else setError(new Error('Задача этого черновика недоступна. Сам черновик сохранён.')); return }
    if (record.key === 'new-definition' || kind === 'definition') { setEditor({ kind: 'definition', definition: projection?.definitions.get(id!), editorId: restorationKey }); return }
    const occurrence = projection?.occurrences.get(id!)
    const definition = occurrence && projection?.definitions.get(occurrence.definitionId)
    if (!occurrence || !definition || !projection) { setError(new Error('Запись этого черновика недоступна. Черновик сохранён.')); return }
    setEditor({ kind: kind === 'placement' ? 'placement' : kind === 'completion' ? 'completion' : 'occurrence', occurrence, definition, planState: projection.planState, editorId: restorationKey })
  }
  function occurrenceCard(occurrence: TaskOccurrence) { return <OccurrenceCard key={occurrence.id} occurrence={occurrence} definition={metadata.current.get(occurrence.definitionId)} timezone={settings!.timezone} refreshRequired={refreshRequired} onEdit={() => void openOccurrence(occurrence, 'occurrence')} onPlace={() => void openOccurrence(occurrence, 'placement')} onComplete={() => void openOccurrence(occurrence, 'completion')} /> }
  return <main id="main-content" className="workspace"><div className="workspace-title"><div><p className="eyebrow">Спокойное планирование</p><h1>Ваши задачи и время</h1><p className="muted">{settings ? `${settings.timezone} · неделя с понедельника` : 'Загружаем настройки…'}</p></div><button type="button" disabled={busy} onClick={() => void refresh().catch(() => undefined)}>{busy ? 'Обновляем…' : 'Обновить'}</button></div>
    <nav className="tabs" aria-label="Разделы планировщика">{([{ value: 'calendar', label: 'Календарь' }, { value: 'tasks', label: 'Задачи' }, { value: 'settings', label: 'Настройки и категории' }] as const).map(item => <button type="button" key={item.value} aria-current={tab === item.value ? 'page' : undefined} onClick={() => { setTab(item.value); setEditor(null); setRestore(null); setNotice('') }}>{item.label}</button>)}</nav>
    {notice && <p className="notice notice--success" role="status">{notice}</p>}<ErrorMessage error={error ?? sync.error} />{range && 'error' in range && <ErrorMessage error={range.error} />}<p className="sync-status" role="status">{sync.status === 'loading' ? 'Загружаем согласованное состояние…' : sync.status === 'ready' ? 'Данные обновляются автоматически' : sync.status === 'stopped' ? 'Синхронизация остановлена' : 'Нет свежего ответа — показана последняя подтверждённая редакция'}</p><LocalRecovery onRestore={restoreDraft} onCleared={onCleared} />{refreshRequired && <p className="notice notice--error" role="alert">Данные требуют обновления. До успешного перечитывания показанные статусы могут быть прежними; новые действия завершения приостановлены.</p>}
    {settings && !settings.place && <div className="notice"><p>Сначала задайте своё место, чтобы создавать задачи с явными условиями.</p><button type="button" onClick={() => setTab('settings')}>Задать место</button></div>}
    {settings && tab === 'calendar' && <><section className="panel"><div className="calendar-toolbar"><div className="segmented" aria-label="Вид календаря"><button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>День</button><button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Неделя</button></div><div className="calendar-navigation"><button type="button" aria-label="Предыдущий период" onClick={() => navigateDate(view === 'day' ? -1 : -7)}>←</button><Field label="Дата календаря"><input type="date" required value={date} onChange={event => { if (event.target.value) setDate(event.target.value) }} /></Field><button type="button" aria-label="Следующий период" onClick={() => navigateDate(view === 'day' ? 1 : 7)}>→</button><button type="button" onClick={() => setDate(today(settings.timezone))}>Сегодня</button></div></div>{validRange && <><div className="calendar-caption"><h2>{view === 'week' ? `${dateLabel(validRange.dates[0]!)} — ${dateLabel(validRange.dates.at(-1)!)}` : dateLabel(date)}</h2><p className="muted">Блоки резервируют время. Наличие блока не означает завершение выполнения.</p></div>{!calendar && <p role="status" className="muted">Загружаем календарь…</p>}<Calendar data={calendar} dates={validRange.dates} timezone={settings.timezone} view={view} onOpen={occurrence => void openOccurrence(occurrence, 'completion')} /></>}</section><Panel title="Незапланированные выполнения"><p className="muted">Здесь только незапланированные и ещё не выполненные дела, независимо от выбранной даты календаря.</p><ErrorMessage error={unplanned.error} />{unplanned.busy && !unplanned.page && <p role="status">Загружаем выполнения…</p>}{unplanned.page?.items.length === 0 && <div className="empty-state"><h3>Свободное место для новых дел</h3><p>Создайте задачу и отдельное выполнение, затем выберите время.</p><button type="button" onClick={() => setTab('tasks')}>Перейти к задачам</button></div>}<div className="card-list">{unplanned.page?.items.map(occurrenceCard)}</div><LoadMore cursor={unplanned.page?.nextCursor} busy={unplanned.busy} onLoad={() => void unplanned.more()} /></Panel></>}
    {settings && tab === 'tasks' && <><Panel title="Описания задач"><div className="section-intro"><p className="muted">Создайте описание и общие условия, затем добавляйте конкретные выполнения.</p><button type="button" className="primary" disabled={!settings.place} onClick={() => void openDefinition()}>Новая задача</button></div><ErrorMessage error={definitions.error} />{definitions.busy && !definitions.page && <p role="status">Загружаем задачи…</p>}{definitions.page?.items.length === 0 && <p className="empty-state">У вас пока нет задач. Добавьте первую.</p>}<div className="definition-grid">{definitions.page?.items.map(definition => <article className="definition-card" key={definition.id}><h3>{definition.title}</h3>{definition.description && <p className="description">{definition.description}</p>}<p className="metadata">{projection?.categories.get(definition.categoryId ?? '')?.name ?? (definition.categoryId ? 'Категория' : 'Без категории')}</p><dl className="task-properties"><div><dt>Важность</dt><dd>{importanceLabels[definition.importance]}</dd></div><div><dt>Сложность</dt><dd>{difficultyLabels[definition.difficulty]}</dd></div><div><dt>Приоритет</dt><dd>{definition.executionPriority}</dd></div><div><dt>Объём новых выполнений</dt><dd>{definition.durationPolicy.requiredWorkMinutes} мин</dd></div></dl><div className="actions"><button type="button" onClick={() => void selectDefinition(definition)}>Выполнения задачи</button><button type="button" className="text-button" onClick={() => void openDefinition(definition)}>Изменить задачу</button></div></article>)}</div><LoadMore cursor={definitions.page?.nextCursor} busy={definitions.busy} onLoad={() => void definitions.more()} /></Panel>{<Panel title={selectedDefinition ? `Выполнения · ${selectedDefinition.title}` : 'Все выполнения'} onClose={selectedDefinition ? () => setSelectedDefinition(null) : undefined}>{selectedDefinition && (supportedDefinition(selectedDefinition) ? <CreateOccurrenceForm key={restore?.key === `create-occurrence:${selectedDefinition.id}` ? restoreKey : selectedDefinition.id} userId={me.userId} definition={selectedDefinition} settings={settings} onSaved={saved} /> : <p className="notice">Условия этой задачи относятся к более новой версии клиента.</p>)}<div className="occurrence-filters"><Field label="Статус выполнения"><select value={completionFilter} onChange={event => setCompletionFilter(event.target.value as CompletionFilter)}><option value="all">Все</option><option value="incomplete">Не выполненные</option><option value="completed">Выполненные</option></select></Field></div><h3 className="list-heading">Созданные выполнения</h3><ErrorMessage error={executions.error} />{executions.busy && !executions.page && <p role="status">Загружаем…</p>}{executions.page?.items.length === 0 && <p className="muted">{completionFilter === 'all' ? 'Выполнений ещё нет.' : 'Нет выполнений с выбранным статусом.'}</p>}<div className="card-list">{executions.page?.items.map(occurrenceCard)}</div><LoadMore cursor={executions.page?.nextCursor} busy={executions.busy} onLoad={() => void executions.more()} /></Panel>}</>}
    {settings && tab === 'settings' && <><SettingsForm key={restore?.key === 'settings' ? restoreKey : 'settings'} userId={me.userId} settings={settings} onSaved={saved} /><Panel title="Категории"><p className="muted">Названия помогают группировать задачи. Созданные категории доступны в форме задачи.</p><ErrorMessage error={categories.error} /><ul className="category-list">{categories.page?.items.map(category => <li key={category.id}>{category.name}</li>)}</ul><LoadMore cursor={categories.page?.nextCursor} busy={categories.busy} onLoad={() => void categories.more()} /><CategoryForm key={restore?.key === 'new-category' ? restoreKey : 'category'} userId={me.userId} onSaved={saved} /></Panel></>}
    {settings && editor && <div ref={editorElement} className="editor-anchor" tabIndex={-1}>{editor.kind === 'definition' ? <DefinitionForm key={editor.editorId} userId={me.userId} definition={editor.definition} settings={settings} categories={categories.page?.items ?? []} moreCategories={!!categories.page?.nextCursor} onMoreCategories={() => void categories.more()} onSaved={saved} onClose={() => setEditor(current => current?.editorId === editor.editorId ? null : current)} /> : editor.kind === 'occurrence' ? <OccurrenceForm key={editor.editorId} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} onSaved={saved} onClose={() => setEditor(current => current?.editorId === editor.editorId ? null : current)} /> : editor.kind === 'completion' ? <CompletionForm key={editor.editorId} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} refreshRequired={refreshRequired} onRefresh={refreshCompletion} onEdit={() => void openOccurrence(editor.occurrence, 'occurrence')} onPlace={() => void openOccurrence(editor.occurrence, 'placement')} onClose={() => setEditor(current => current?.editorId === editor.editorId ? null : current)} /> : <PlacementForm key={editor.editorId} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} planState={editor.planState} onSaved={saved} onClose={() => setEditor(current => current?.editorId === editor.editorId ? null : current)} />}</div>}
  </main>
}

function App() {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [checking, setChecking] = useState(true)
  const [working, setWorking] = useState(false)
  const [userName, setUserName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [sessionNotice, setSessionNotice] = useState('')
  const channel = useRef<BroadcastChannel | null>(null)
  function expire(message = 'Сеанс истёк или изменился. Войдите снова. Ввод сохранён для исходного аккаунта.') {
    identityState.activate(null); resetTransport(); setMe(null); setChecking(false); setSessionNotice(message)
  }
  function activate(current: MeResponse) { identityState.activate(current.userId); setMe(current); setError(null); setSessionNotice('') }
  async function checkSession() {
    setChecking(true); setError(null)
    try { activate(await restoreSession()) } catch (failure) { if (!(failure instanceof ApiError && failure.problem.status === 401)) setError(asError(failure)) } finally { setChecking(false) }
  }
  useEffect(() => {
    let active = true
    setExpiredHandler(() => { if (active) expire() })
    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('vibe-identity')
      channel.current.onmessage = () => expire('Сеанс изменился в другой вкладке. Личные данные скрыты; проверьте текущий сеанс или войдите заново.')
    }
    void restoreSession().then(current => { if (active) activate(current) }).catch(failure => { if (active && !(failure instanceof ApiError && failure.problem.status === 401)) setError(asError(failure)) }).finally(() => { if (active) setChecking(false) })
    return () => { active = false; setExpiredHandler(() => undefined); channel.current?.close(); resetTransport() }
  }, [])
  async function signIn(event: FormEvent) {
    event.preventDefault(); setWorking(true); setError(null)
    try { const current = await login(userName, password); activate(current); setPassword(''); channel.current?.postMessage({ changed: true }) } catch (failure) { setError(asError(failure)) } finally { setWorking(false) }
  }
  async function signOut() {
    if (!me) return
    setWorking(true); setError(null)
    try { await logout(me.userId); expire('Вы вышли. Черновики доступны только после входа в исходный аккаунт в этой вкладке.'); channel.current?.postMessage({ changed: true }) } catch (failure) { if (failure instanceof ApiError && failure.problem.status === 401) expire(); else setError(asError(failure)) } finally { setWorking(false) }
  }
  return <div className="page-shell"><a className="skip-link" href="#main-content">К основному содержимому</a><header className="site-header"><div className="brand"><img src="/vibe.svg" width="40" height="40" alt="" /><span>Vibe</span></div>{me ? <div className="account"><span>{me.userName}</span><button type="button" onClick={() => void signOut()} disabled={working}>{working ? 'Выходим…' : 'Выйти'}</button></div> : <span className="stage-badge">Ваше время — под рукой</span>}</header>
    {me ? <><ErrorMessage error={error} /><Workspace key={`${me.userId}:${identityState.epoch}`} me={me} /></> : <main id="main-content" className="login-layout"><section className="hero-copy"><p className="eyebrow">Персональный планировщик</p><h1>Время для того,<br />что <span>важно.</span></h1><p>Создавайте задачи, сохраняйте условия каждого выполнения и выбирайте подходящее время в календаре.</p></section><section className="panel login-panel"><h2>{checking ? 'Проверяем сеанс…' : 'Войти в Vibe'}</h2>{sessionNotice && <p className="notice" role="status">{sessionNotice}</p>}<ErrorMessage error={error} /><form onSubmit={event => void signIn(event)}><fieldset disabled={working || checking}><Field label="Имя пользователя"><input required autoComplete="username" value={userName} onChange={event => setUserName(event.target.value)} /></Field><Field label="Пароль"><input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field><SubmitButton busy={working}>Войти</SubmitButton></fieldset></form><button className="text-button" type="button" disabled={working || checking} onClick={() => void checkSession()}>Проверить текущий сеанс</button><p className="muted">Вход для подготовленных владельцем учётных записей.</p></section></main>}
    <datalist id="timezones"><option value="Europe/Moscow" /><option value="Europe/Berlin" /><option value="Europe/London" /><option value="America/New_York" /><option value="America/Santiago" /><option value="Asia/Tokyo" /><option value="Australia/Lord_Howe" /><option value="UTC" /></datalist><footer className="site-footer"><p>Vibe · Место для важных дел.</p><span>Задачи, календарь и завершения</span></footer></div>
}
export default App

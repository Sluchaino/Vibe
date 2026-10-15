import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError, IdentityChangedError, login, logout, read, resetTransport, restoreSession, setExpiredHandler } from './api/client'
import type { CalendarResponse, Category, DefinitionResponse, MeResponse, OccurrenceResponse, Page, PlanState, SettingsResponse, TaskDefinition, TaskOccurrence } from './api/types'
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
import { hasCurrentCompletion, isCompleted, occurrenceListPath, type CompletionFilter } from './lib/completion'
import { freshAfterAcknowledgement } from './lib/fresh-read'
import { PageRequestGate } from './lib/paging'
import { identityState } from './state/session'

const importanceLabels = { low: 'Низкая', normal: 'Обычная', high: 'Высокая' }
const difficultyLabels = { light: 'Лёгкая', medium: 'Средняя', heavy: 'Тяжёлая' }
function asError(error: unknown) { return error instanceof Error ? error : new Error('Не удалось получить данные.') }
function usePage<T extends { id: string }>(path: string) {
  const [page, setPage] = useState<Page<T> | null>(null)
  const [pagePath, setPagePath] = useState(path)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const gate = useRef(new PageRequestGate())
  gate.current.select(path)
  const pathRef = useRef(path)
  pathRef.current = path
  const pageRef = useRef(page)
  pageRef.current = pagePath === path ? page : null
  async function load(append = false) {
    setBusy(true); setError(null)
    const currentPath = pathRef.current
    const request = gate.current.begin(currentPath)
    const cursor = append ? pageRef.current?.nextCursor : null
    const url = `${currentPath}${currentPath.includes('?') ? '&' : '?'}pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    try {
      const result = await read<Page<T>>(url)
      if (!gate.current.accepts(request)) return
      setPagePath(currentPath)
      setPage(previous => { const items = append && previous ? [...previous.items, ...result.items] : result.items; return { ...result, items: [...new Map(items.map(item => [item.id, item])).values()] } })
    } catch (failure) { if (gate.current.accepts(request)) setError(asError(failure)); throw failure } finally { if (gate.current.accepts(request)) setBusy(false) }
  }
  useEffect(() => { setPage(null); void load().catch(() => undefined); return () => { gate.current.invalidate() } }, [path])
  return { page: pagePath === path ? page : null, busy, error, refresh: () => load(), more: () => load(true).catch(() => undefined) }
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

type Editor = { kind: 'definition'; definition?: TaskDefinition } | { kind: 'occurrence' | 'placement' | 'completion'; occurrence: TaskOccurrence; definition: TaskDefinition; planState: PlanState }
function Workspace({ me }: { me: MeResponse }) {
  const [tab, setTab] = useState<'calendar' | 'tasks' | 'settings'>('calendar')
  const [settingsData, setSettingsData] = useState<SettingsResponse | null>(null)
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null)
  const [view, setView] = useState<'day' | 'week'>('week')
  const [date, setDate] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [selectedDefinition, setSelectedDefinition] = useState<TaskDefinition | null>(null)
  const [notice, setNotice] = useState('')
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter>('all')
  const settings = settingsData?.settings
  const categories = usePage<Category>('/categories')
  const definitions = usePage<TaskDefinition>('/task-definitions')
  const unplanned = usePage<TaskOccurrence>(occurrenceListPath('incomplete', undefined, true))
  const executions = usePage<TaskOccurrence>(occurrenceListPath(completionFilter, selectedDefinition?.id))
  const completionRefreshes = useRef(new Map<string, number>())
  const calendarGeneration = useRef(0)
  const settingsGeneration = useRef(0)
  const editorElement = useRef<HTMLDivElement>(null)
  const metadata = useRef(new Map<string, TaskDefinition>())
  const [, updateMetadata] = useState(0)
  const range = useMemo(() => { if (!settings || !date) return null; try { return calendarRange(date, view, settings.timezone) } catch (failure) { return { error: asError(failure) } } }, [date, view, settings?.timezone])
  const validRange = range && !('error' in range) ? range : null
  const rangeRef = useRef(validRange)
  rangeRef.current = validRange
  async function loadSettings() {
    const generation = ++settingsGeneration.current
    const result = await read<SettingsResponse>('/settings')
    if (generation !== settingsGeneration.current) return
    setSettingsData(result); setDate(previous => previous || today(result.settings.timezone))
  }
  async function loadCalendar() {
    const currentRange = rangeRef.current
    if (!currentRange) return
    const generation = ++calendarGeneration.current
    const result = await read<CalendarResponse>(`/calendar?from=${encodeURIComponent(currentRange.from)}&to=${encodeURIComponent(currentRange.to)}`)
    if (generation !== calendarGeneration.current) return
    setCalendar(result)
    for (const definition of result.definitions) metadata.current.set(definition.id, definition)
    updateMetadata(value => value + 1)
  }
  useEffect(() => { void loadSettings().catch(failure => setError(asError(failure))) }, [])
  useEffect(() => {
    setCalendar(null)
    if (range && 'error' in range) { setError(range.error); return }
    void loadCalendar().catch(failure => setError(asError(failure)))
    return () => { calendarGeneration.current++ }
  }, [validRange?.from, validRange?.to])
  useEffect(() => {
    for (const definition of definitions.page?.items ?? []) metadata.current.set(definition.id, definition)
    const missing = new Set([...(unplanned.page?.items ?? []), ...(executions.page?.items ?? [])].map(item => item.definitionId).filter(id => !metadata.current.has(id)))
    let active = true
    void Promise.all([...missing].map(async id => { try { const result = await read<DefinitionResponse>(`/task-definitions/${id}`); if (active) metadata.current.set(id, result.definition) } catch { /* opening this resource reports read failure */ } })).then(() => { if (active) updateMetadata(value => value + 1) })
    return () => { active = false }
  }, [definitions.page, unplanned.page, executions.page])
  useEffect(() => { if (editor) { editorElement.current?.scrollIntoView({ behavior: 'auto', block: 'start' }); editorElement.current?.focus() } }, [editor])
  async function refresh(keepRequired = false) {
    setBusy(true); setError(null); setNotice('')
    const results = await Promise.allSettled([loadSettings(), categories.refresh(), definitions.refresh(), unplanned.refresh(), executions.refresh(), loadCalendar()])
    const failed = results.find(result => result.status === 'rejected')
    setBusy(false)
    if (failed?.status === 'rejected') { setRefreshRequired(true); setError(asError(failed.reason)); throw failed.reason }
    if (!keepRequired) setRefreshRequired(false)
  }
  async function saved() { await refresh(); setNotice('Изменения сохранены на сервере, состояние обновлено.') }
  async function refreshCompletion(id: string) {
    const epoch = identityState.epoch
    const generation = (completionRefreshes.current.get(id) ?? 0) + 1
    completionRefreshes.current.set(id, generation)
    const scoped = () => identityState.epoch === epoch && identityState.userId === me.userId && completionRefreshes.current.get(id) === generation
    setRefreshRequired(true); setNotice('')
    let fresh: OccurrenceResponse | undefined
    try {
      const applied = await freshAfterAcknowledgement(() => read<OccurrenceResponse>(`/occurrences/${id}`), () => refresh(true), scoped, result => {
        if (!hasCurrentCompletion(result.occurrence)) throw new Error('Сервер вернул старый формат выполнения. Обновите страницу после обновления сервера.')
        fresh = result
        setEditor(current => current && current.kind !== 'definition' && current.occurrence.id === id ? { ...current, occurrence: result.occurrence, planState: result.planState } : current)
      })
      if (!applied || !fresh) throw new IdentityChangedError('Состояние изменилось во время обновления. Перечитайте выполнение.')
      setRefreshRequired(false); setNotice('Состояние выполнения обновлено.')
      return fresh
    } catch (failure) { if (scoped()) { setRefreshRequired(true); setError(asError(failure)) } throw failure }
  }
  async function openDefinition(definition?: TaskDefinition) {
    setError(null)
    try { const current = definition ? (await read<DefinitionResponse>(`/task-definitions/${definition.id}`)).definition : undefined; if (current && !supportedDefinition(current)) throw new Error('У этой задачи есть условия более новой версии. Редактирование текущим клиентом недоступно, чтобы сохранить все данные.'); setEditor({ kind: 'definition', definition: current }) } catch (failure) { setError(asError(failure)) }
  }
  async function openOccurrence(occurrence: TaskOccurrence, kind: 'occurrence' | 'placement' | 'completion') {
    setError(null)
    try {
      const result = await read<OccurrenceResponse>(`/occurrences/${occurrence.id}`)
      if (!hasCurrentCompletion(result.occurrence)) throw new Error('Обновите страницу после обновления сервера: для этого выполнения нужен актуальный статус завершения.')
      if (!supportedConstraints(result.occurrence.constraintsSnapshot)) throw new Error('Это выполнение содержит условия более новой версии. Текущий клиент сохраняет их без редактирования.')
      const definition = (await read<DefinitionResponse>(`/task-definitions/${result.occurrence.definitionId}`)).definition
      metadata.current.set(definition.id, definition)
      setEditor({ kind, occurrence: result.occurrence, definition, planState: result.planState })
    } catch (failure) { setError(asError(failure)) }
  }
  async function selectDefinition(definition: TaskDefinition) { try { setSelectedDefinition((await read<DefinitionResponse>(`/task-definitions/${definition.id}`)).definition); setEditor(null) } catch (failure) { setError(asError(failure)) } }
  function occurrenceCard(occurrence: TaskOccurrence) { return <OccurrenceCard key={occurrence.id} occurrence={occurrence} definition={metadata.current.get(occurrence.definitionId)} timezone={settings!.timezone} refreshRequired={refreshRequired} onEdit={() => void openOccurrence(occurrence, 'occurrence')} onPlace={() => void openOccurrence(occurrence, 'placement')} onComplete={() => void openOccurrence(occurrence, 'completion')} /> }
  return <main id="main-content" className="workspace"><div className="workspace-title"><div><p className="eyebrow">Спокойное планирование</p><h1>Ваши задачи и время</h1><p className="muted">{settings ? `${settings.timezone} · неделя с понедельника` : 'Загружаем настройки…'}</p></div><button type="button" disabled={busy} onClick={() => void refresh().catch(() => undefined)}>{busy ? 'Обновляем…' : 'Обновить'}</button></div>
    <nav className="tabs" aria-label="Разделы планировщика">{([{ value: 'calendar', label: 'Календарь' }, { value: 'tasks', label: 'Задачи' }, { value: 'settings', label: 'Настройки и категории' }] as const).map(item => <button type="button" key={item.value} aria-current={tab === item.value ? 'page' : undefined} onClick={() => { setTab(item.value); setEditor(null); setNotice('') }}>{item.label}</button>)}</nav>
    {notice && <p className="notice notice--success" role="status">{notice}</p>}<ErrorMessage error={error} />{refreshRequired && <p className="notice notice--error" role="alert">Данные требуют обновления. До успешного перечитывания показанные статусы могут быть прежними; новые действия завершения приостановлены.</p>}
    {settings && !settings.place && <div className="notice"><p>Сначала задайте своё место, чтобы создавать задачи с явными условиями.</p><button type="button" onClick={() => setTab('settings')}>Задать место</button></div>}
    {settings && tab === 'calendar' && <><section className="panel"><div className="calendar-toolbar"><div className="segmented" aria-label="Вид календаря"><button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>День</button><button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Неделя</button></div><div className="calendar-navigation"><button type="button" aria-label="Предыдущий период" onClick={() => setDate(addDays(date, view === 'day' ? -1 : -7))}>←</button><Field label="Дата календаря"><input type="date" required value={date} onChange={event => { if (event.target.value) setDate(event.target.value) }} /></Field><button type="button" aria-label="Следующий период" onClick={() => setDate(addDays(date, view === 'day' ? 1 : 7))}>→</button><button type="button" onClick={() => setDate(today(settings.timezone))}>Сегодня</button></div></div>{validRange && <><div className="calendar-caption"><h2>{view === 'week' ? `${dateLabel(validRange.dates[0]!)} — ${dateLabel(validRange.dates.at(-1)!)}` : dateLabel(date)}</h2><p className="muted">Блоки резервируют время. Наличие блока не означает завершение выполнения.</p></div>{!calendar && <p role="status" className="muted">Загружаем календарь…</p>}<Calendar data={calendar} dates={validRange.dates} timezone={settings.timezone} view={view} onOpen={occurrence => void openOccurrence(occurrence, 'completion')} /></>}</section><Panel title="Незапланированные выполнения"><p className="muted">Здесь только незапланированные и ещё не выполненные дела, независимо от выбранной даты календаря.</p><ErrorMessage error={unplanned.error} />{unplanned.busy && !unplanned.page && <p role="status">Загружаем выполнения…</p>}{unplanned.page?.items.length === 0 && <div className="empty-state"><h3>Свободное место для новых дел</h3><p>Создайте задачу и отдельное выполнение, затем выберите время.</p><button type="button" onClick={() => setTab('tasks')}>Перейти к задачам</button></div>}<div className="card-list">{unplanned.page?.items.map(occurrenceCard)}</div><LoadMore cursor={unplanned.page?.nextCursor} busy={unplanned.busy} onLoad={() => void unplanned.more()} /></Panel></>}
    {settings && tab === 'tasks' && <><Panel title="Описания задач"><div className="section-intro"><p className="muted">Создайте описание и общие условия, затем добавляйте конкретные выполнения.</p><button type="button" className="primary" disabled={!settings.place} onClick={() => void openDefinition()}>Новая задача</button></div><ErrorMessage error={definitions.error} />{definitions.busy && !definitions.page && <p role="status">Загружаем задачи…</p>}{definitions.page?.items.length === 0 && <p className="empty-state">У вас пока нет задач. Добавьте первую.</p>}<div className="definition-grid">{definitions.page?.items.map(definition => <article className="definition-card" key={definition.id}><h3>{definition.title}</h3>{definition.description && <p className="description">{definition.description}</p>}<p className="metadata">{categories.page?.items.find(category => category.id === definition.categoryId)?.name ?? (definition.categoryId ? 'Категория' : 'Без категории')}</p><dl className="task-properties"><div><dt>Важность</dt><dd>{importanceLabels[definition.importance]}</dd></div><div><dt>Сложность</dt><dd>{difficultyLabels[definition.difficulty]}</dd></div><div><dt>Приоритет</dt><dd>{definition.executionPriority}</dd></div><div><dt>Объём новых выполнений</dt><dd>{definition.durationPolicy.requiredWorkMinutes} мин</dd></div></dl><div className="actions"><button type="button" onClick={() => void selectDefinition(definition)}>Выполнения задачи</button><button type="button" className="text-button" onClick={() => void openDefinition(definition)}>Изменить задачу</button></div></article>)}</div><LoadMore cursor={definitions.page?.nextCursor} busy={definitions.busy} onLoad={() => void definitions.more()} /></Panel>{<Panel title={selectedDefinition ? `Выполнения · ${selectedDefinition.title}` : 'Все выполнения'} onClose={selectedDefinition ? () => setSelectedDefinition(null) : undefined}>{selectedDefinition && (supportedDefinition(selectedDefinition) ? <CreateOccurrenceForm key={selectedDefinition.id} userId={me.userId} definition={selectedDefinition} settings={settings} onSaved={saved} /> : <p className="notice">Условия этой задачи относятся к более новой версии клиента.</p>)}<div className="occurrence-filters"><Field label="Статус выполнения"><select value={completionFilter} onChange={event => setCompletionFilter(event.target.value as CompletionFilter)}><option value="all">Все</option><option value="incomplete">Не выполненные</option><option value="completed">Выполненные</option></select></Field></div><h3 className="list-heading">Созданные выполнения</h3><ErrorMessage error={executions.error} />{executions.busy && !executions.page && <p role="status">Загружаем…</p>}{executions.page?.items.length === 0 && <p className="muted">{completionFilter === 'all' ? 'Выполнений ещё нет.' : 'Нет выполнений с выбранным статусом.'}</p>}<div className="card-list">{executions.page?.items.map(occurrenceCard)}</div><LoadMore cursor={executions.page?.nextCursor} busy={executions.busy} onLoad={() => void executions.more()} /></Panel>}</>}
    {settings && tab === 'settings' && <><SettingsForm key={settings.serverVersion} userId={me.userId} settings={settings} onSaved={saved} /><Panel title="Категории"><p className="muted">Названия помогают группировать задачи. Созданные категории доступны в форме задачи.</p><ErrorMessage error={categories.error} /><ul className="category-list">{categories.page?.items.map(category => <li key={category.id}>{category.name}</li>)}</ul><LoadMore cursor={categories.page?.nextCursor} busy={categories.busy} onLoad={() => void categories.more()} /><CategoryForm userId={me.userId} onSaved={saved} /></Panel></>}
    {settings && editor && <div ref={editorElement} className="editor-anchor" tabIndex={-1}>{editor.kind === 'definition' ? <DefinitionForm key={editor.definition?.id ?? 'new'} userId={me.userId} definition={editor.definition} settings={settings} categories={categories.page?.items ?? []} moreCategories={!!categories.page?.nextCursor} onMoreCategories={() => void categories.more()} onSaved={saved} onClose={() => setEditor(current => current === editor ? null : current)} /> : editor.kind === 'occurrence' ? <OccurrenceForm key={`occurrence:${editor.occurrence.id}`} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} onSaved={saved} onClose={() => setEditor(current => current === editor ? null : current)} /> : editor.kind === 'completion' ? <CompletionForm key={`completion:${editor.occurrence.id}`} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} refreshRequired={refreshRequired} onRefresh={refreshCompletion} onEdit={() => void openOccurrence(editor.occurrence, 'occurrence')} onPlace={() => void openOccurrence(editor.occurrence, 'placement')} onClose={() => setEditor(current => current === editor ? null : current)} /> : <PlacementForm key={`placement:${editor.occurrence.id}`} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} planState={editor.planState} onSaved={saved} onClose={() => setEditor(current => current === editor ? null : current)} />}</div>}
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

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError, login, logout, read, resetTransport, restoreSession, setExpiredHandler } from './api/client'
import type { CalendarResponse, Category, DefinitionResponse, MeResponse, OccurrenceResponse, Page, PlanState, SettingsResponse, TaskDefinition, TaskOccurrence } from './api/types'
import { Calendar } from './components/Calendar'
import { CategoryForm } from './components/CategoryForm'
import { supportedConstraints } from './components/ConstraintsForm'
import { DefinitionForm } from './components/DefinitionForm'
import { CreateOccurrenceForm, OccurrenceForm } from './components/OccurrenceForm'
import { PlacementForm } from './components/PlacementForm'
import { SettingsForm } from './components/SettingsForm'
import { ErrorMessage, Field, Panel, SubmitButton } from './components/shared'
import { effectiveFixed } from './lib/operations'
import { addDays, calendarRange, dateLabel, instantLabel, today } from './lib/time'
import { identityState } from './state/session'

const importanceLabels = { low: 'Низкая', normal: 'Обычная', high: 'Высокая' }
const difficultyLabels = { light: 'Лёгкая', medium: 'Средняя', heavy: 'Тяжёлая' }
function asError(error: unknown) { return error instanceof Error ? error : new Error('Не удалось получить данные.') }
function usePage<T extends { id: string }>(path: string) {
  const [page, setPage] = useState<Page<T> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const generation = useRef(0)
  const pathRef = useRef(path)
  pathRef.current = path
  const pageRef = useRef(page)
  pageRef.current = page
  async function load(append = false) {
    const request = ++generation.current
    setBusy(true); setError(null)
    const currentPath = pathRef.current
    const cursor = append ? pageRef.current?.nextCursor : null
    const url = `${currentPath}${currentPath.includes('?') ? '&' : '?'}pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    try {
      const result = await read<Page<T>>(url)
      if (request !== generation.current) return
      setPage(previous => { const items = append && previous ? [...previous.items, ...result.items] : result.items; return { ...result, items: [...new Map(items.map(item => [item.id, item])).values()] } })
    } catch (failure) { if (request === generation.current) setError(asError(failure)) } finally { if (request === generation.current) setBusy(false) }
  }
  useEffect(() => { setPage(null); void load(); return () => { generation.current++ } }, [path])
  return { page, busy, error, refresh: () => load(), more: () => load(true) }
}
function LoadMore({ cursor, busy, onLoad }: { cursor?: string | null; busy: boolean; onLoad: () => void }) { return cursor ? <button className="load-more" type="button" disabled={busy} onClick={onLoad}>{busy ? 'Загружаем…' : 'Показать ещё'}</button> : null }
function supportedDefinition(value: TaskDefinition) {
  const known = ['id', 'serverVersion', 'title', 'description', 'categoryId', 'importance', 'difficulty', 'executionPriority', 'durationPolicy', 'splitAllowed', 'mobilityPolicy', 'availabilityRules', 'placeId', 'requiredRestMinutes']
  const snapshot = { durationPolicy: value.durationPolicy, splitAllowed: value.splitAllowed, mobilityPolicy: value.mobilityPolicy, availabilityRules: value.availabilityRules, placeId: value.placeId, requiredRestMinutes: value.requiredRestMinutes }
  return known.every(key => key in value) && Object.keys(value).every(key => known.includes(key)) && supportedConstraints(snapshot)
}
function OccurrenceCard({ occurrence, definition, timezone, onEdit, onPlace }: { occurrence: TaskOccurrence; definition?: TaskDefinition; timezone: string; onEdit: () => void; onPlace: () => void }) {
  return <article className="occurrence-card"><div><h3>{definition?.title ?? 'Выполнение'}</h3><p className="muted">Дата выполнения: {occurrence.logicalDate} · {occurrence.remainingWorkMinutes} мин</p>{definition && <p className="metadata">Важность: {importanceLabels[definition.importance]} · Сложность: {difficultyLabels[definition.difficulty]} · Приоритет: {definition.executionPriority}</p>}{occurrence.calendarBlock ? <p className="block-summary">{instantLabel(occurrence.calendarBlock.startInstant, timezone)} — {instantLabel(occurrence.calendarBlock.endInstant, timezone)}{effectiveFixed(occurrence) && ' · закреплено'}</p> : <span className="status-pill">Не запланировано</span>}</div><div className="actions"><button type="button" onClick={onPlace}>{occurrence.calendarBlock ? 'Изменить размещение' : 'В календарь'}</button><button type="button" className="text-button" onClick={onEdit}>Условия выполнения</button></div></article>
}

type Editor = { kind: 'definition'; definition?: TaskDefinition } | { kind: 'occurrence' | 'placement'; occurrence: TaskOccurrence; definition: TaskDefinition; planState: PlanState }
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
  const settings = settingsData?.settings
  const categories = usePage<Category>('/categories')
  const definitions = usePage<TaskDefinition>('/task-definitions')
  const unplanned = usePage<TaskOccurrence>('/occurrences?placementStatus=unplanned')
  const executions = usePage<TaskOccurrence>(selectedDefinition ? `/occurrences?definitionId=${selectedDefinition.id}` : '/occurrences')
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
  async function refresh() {
    setBusy(true); setError(null)
    const results = await Promise.allSettled([loadSettings(), categories.refresh(), definitions.refresh(), unplanned.refresh(), executions.refresh(), loadCalendar()])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') setError(asError(failed.reason))
    setBusy(false)
  }
  async function saved() { setNotice('Изменения сохранены на сервере.'); await refresh() }
  async function openDefinition(definition?: TaskDefinition) {
    setError(null)
    try { const current = definition ? (await read<DefinitionResponse>(`/task-definitions/${definition.id}`)).definition : undefined; if (current && !supportedDefinition(current)) throw new Error('У этой задачи есть условия более новой версии. Редактирование текущим клиентом недоступно, чтобы сохранить все данные.'); setEditor({ kind: 'definition', definition: current }) } catch (failure) { setError(asError(failure)) }
  }
  async function openOccurrence(occurrence: TaskOccurrence, kind: 'occurrence' | 'placement') {
    setError(null)
    try {
      const result = await read<OccurrenceResponse>(`/occurrences/${occurrence.id}`)
      if (!supportedConstraints(result.occurrence.constraintsSnapshot)) throw new Error('Это выполнение содержит условия более новой версии. Текущий клиент сохраняет их без редактирования.')
      const definition = (await read<DefinitionResponse>(`/task-definitions/${result.occurrence.definitionId}`)).definition
      metadata.current.set(definition.id, definition)
      setEditor({ kind, occurrence: result.occurrence, definition, planState: result.planState })
    } catch (failure) { setError(asError(failure)) }
  }
  async function selectDefinition(definition: TaskDefinition) { try { setSelectedDefinition((await read<DefinitionResponse>(`/task-definitions/${definition.id}`)).definition); setEditor(null) } catch (failure) { setError(asError(failure)) } }
  function occurrenceCard(occurrence: TaskOccurrence) { return <OccurrenceCard key={occurrence.id} occurrence={occurrence} definition={metadata.current.get(occurrence.definitionId)} timezone={settings!.timezone} onEdit={() => void openOccurrence(occurrence, 'occurrence')} onPlace={() => void openOccurrence(occurrence, 'placement')} /> }
  return <main id="main-content" className="workspace"><div className="workspace-title"><div><p className="eyebrow">Спокойное планирование</p><h1>Ваши задачи и время</h1><p className="muted">{settings ? `${settings.timezone} · неделя с понедельника` : 'Загружаем настройки…'}</p></div><button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Обновляем…' : 'Обновить'}</button></div>
    <nav className="tabs" aria-label="Разделы планировщика">{([{ value: 'calendar', label: 'Календарь' }, { value: 'tasks', label: 'Задачи' }, { value: 'settings', label: 'Настройки и категории' }] as const).map(item => <button type="button" key={item.value} aria-current={tab === item.value ? 'page' : undefined} onClick={() => { setTab(item.value); setEditor(null); setNotice('') }}>{item.label}</button>)}</nav>
    {notice && <p className="notice notice--success" role="status">{notice}</p>}<ErrorMessage error={error} />
    {settings && !settings.place && <div className="notice"><p>Сначала задайте своё место, чтобы создавать задачи с явными условиями.</p><button type="button" onClick={() => setTab('settings')}>Задать место</button></div>}
    {settings && tab === 'calendar' && <><section className="panel"><div className="calendar-toolbar"><div className="segmented" aria-label="Вид календаря"><button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>День</button><button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Неделя</button></div><div className="calendar-navigation"><button type="button" aria-label="Предыдущий период" onClick={() => setDate(addDays(date, view === 'day' ? -1 : -7))}>←</button><Field label="Дата календаря"><input type="date" required value={date} onChange={event => { if (event.target.value) setDate(event.target.value) }} /></Field><button type="button" aria-label="Следующий период" onClick={() => setDate(addDays(date, view === 'day' ? 1 : 7))}>→</button><button type="button" onClick={() => setDate(today(settings.timezone))}>Сегодня</button></div></div>{validRange && <><div className="calendar-caption"><h2>{view === 'week' ? `${dateLabel(validRange.dates[0]!)} — ${dateLabel(validRange.dates.at(-1)!)}` : dateLabel(date)}</h2><p className="muted">Блоки резервируют время. Наличие блока не означает завершение выполнения.</p></div>{!calendar && <p role="status" className="muted">Загружаем календарь…</p>}<Calendar data={calendar} dates={validRange.dates} timezone={settings.timezone} view={view} onOpen={occurrence => void openOccurrence(occurrence, 'placement')} /></>}</section><Panel title="Незапланированные выполнения"><p className="muted">Здесь весь незапланированный объём, независимо от выбранной даты календаря.</p><ErrorMessage error={unplanned.error} />{unplanned.busy && !unplanned.page && <p role="status">Загружаем выполнения…</p>}{unplanned.page?.items.length === 0 && <div className="empty-state"><h3>Свободное место для новых дел</h3><p>Создайте задачу и отдельное выполнение, затем выберите время.</p><button type="button" onClick={() => setTab('tasks')}>Перейти к задачам</button></div>}<div className="card-list">{unplanned.page?.items.map(occurrenceCard)}</div><LoadMore cursor={unplanned.page?.nextCursor} busy={unplanned.busy} onLoad={() => void unplanned.more()} /></Panel></>}
    {settings && tab === 'tasks' && <><Panel title="Описания задач"><div className="section-intro"><p className="muted">Создайте описание и общие условия, затем добавляйте конкретные выполнения.</p><button type="button" className="primary" disabled={!settings.place} onClick={() => void openDefinition()}>Новая задача</button></div><ErrorMessage error={definitions.error} />{definitions.busy && !definitions.page && <p role="status">Загружаем задачи…</p>}{definitions.page?.items.length === 0 && <p className="empty-state">У вас пока нет задач. Добавьте первую.</p>}<div className="definition-grid">{definitions.page?.items.map(definition => <article className="definition-card" key={definition.id}><h3>{definition.title}</h3>{definition.description && <p className="description">{definition.description}</p>}<p className="metadata">{categories.page?.items.find(category => category.id === definition.categoryId)?.name ?? (definition.categoryId ? 'Категория' : 'Без категории')}</p><dl className="task-properties"><div><dt>Важность</dt><dd>{importanceLabels[definition.importance]}</dd></div><div><dt>Сложность</dt><dd>{difficultyLabels[definition.difficulty]}</dd></div><div><dt>Приоритет</dt><dd>{definition.executionPriority}</dd></div><div><dt>Объём новых выполнений</dt><dd>{definition.durationPolicy.requiredWorkMinutes} мин</dd></div></dl><div className="actions"><button type="button" onClick={() => void selectDefinition(definition)}>Выполнения задачи</button><button type="button" className="text-button" onClick={() => void openDefinition(definition)}>Изменить задачу</button></div></article>)}</div><LoadMore cursor={definitions.page?.nextCursor} busy={definitions.busy} onLoad={() => void definitions.more()} /></Panel>{selectedDefinition && <Panel title={`Выполнения · ${selectedDefinition.title}`} onClose={() => setSelectedDefinition(null)}>{supportedDefinition(selectedDefinition) ? <CreateOccurrenceForm key={selectedDefinition.id} userId={me.userId} definition={selectedDefinition} settings={settings} onSaved={saved} /> : <p className="notice">Условия этой задачи относятся к более новой версии клиента.</p>}<h3 className="list-heading">Созданные выполнения</h3><ErrorMessage error={executions.error} />{executions.busy && !executions.page && <p role="status">Загружаем…</p>}{executions.page?.items.length === 0 && <p className="muted">Выполнений ещё нет.</p>}<div className="card-list">{executions.page?.items.map(occurrenceCard)}</div><LoadMore cursor={executions.page?.nextCursor} busy={executions.busy} onLoad={() => void executions.more()} /></Panel>}</>}
    {settings && tab === 'settings' && <><SettingsForm key={settings.serverVersion} userId={me.userId} settings={settings} onSaved={saved} /><Panel title="Категории"><p className="muted">Названия помогают группировать задачи. Созданные категории доступны в форме задачи.</p><ErrorMessage error={categories.error} /><ul className="category-list">{categories.page?.items.map(category => <li key={category.id}>{category.name}</li>)}</ul><LoadMore cursor={categories.page?.nextCursor} busy={categories.busy} onLoad={() => void categories.more()} /><CategoryForm userId={me.userId} onSaved={saved} /></Panel></>}
    {settings && editor && <div ref={editorElement} className="editor-anchor" tabIndex={-1}>{editor.kind === 'definition' ? <DefinitionForm key={editor.definition?.id ?? 'new'} userId={me.userId} definition={editor.definition} settings={settings} categories={categories.page?.items ?? []} moreCategories={!!categories.page?.nextCursor} onMoreCategories={() => void categories.more()} onSaved={saved} onClose={() => setEditor(current => current === editor ? null : current)} /> : editor.kind === 'occurrence' ? <OccurrenceForm key={`occurrence:${editor.occurrence.id}`} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} onSaved={saved} onClose={() => setEditor(current => current === editor ? null : current)} /> : <PlacementForm key={`placement:${editor.occurrence.id}`} userId={me.userId} occurrence={editor.occurrence} title={editor.definition.title} settings={settings} planState={editor.planState} onSaved={saved} onClose={() => setEditor(current => current === editor ? null : current)} />}</div>}
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
    <datalist id="timezones"><option value="Europe/Moscow" /><option value="Europe/Berlin" /><option value="Europe/London" /><option value="America/New_York" /><option value="America/Santiago" /><option value="Asia/Tokyo" /><option value="Australia/Lord_Howe" /><option value="UTC" /></datalist><footer className="site-footer"><p>Vibe · Место для важных дел.</p><span>Ручной календарь · D1</span></footer></div>
}
export default App

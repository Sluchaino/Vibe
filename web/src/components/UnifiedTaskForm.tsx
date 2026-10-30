import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Category, DefinitionFields, UserSettings } from '../api/types'
import { RuntimeContext, useLocalState, useRuntime, useSyncState } from '../sync/context'
import { adaptRestoredUnified, draftFromUnifiedIntent, freshUnifiedDraft, isUnifiedRecord, prepareUnified, runUnifiedCreation, scheduleInput, unifiedStage, type UnifiedDraft, type UnifiedIntent, type UnifiedRecord } from '../lib/unified-task'
import { timeIntent, timingPreview, validDate, workOrigin } from '../lib/task-timing'
import { codePointLength } from '../lib/operations'
import { sameDraftRevision } from '../lib/durable-draft'
import { today } from '../lib/time'
import { constraints } from './ConstraintsForm'
import { advancedScreens, TaskTimeSettings, type SettingsScreen } from './TaskTimeSettings'
import { taskTimeSummary } from '../lib/task-time-summary'
import { timeRangeText, timingFromRange } from '../lib/time-range'
import { DraftStatus, ErrorMessage, Field, Panel, useVersionedDraft } from './shared'
import { DefinitionSummary, definitionSummaryValue, OccurrenceSummary } from './RecordSummary'
import { RecurrenceSummary } from './RecurrenceFields'

type Props = { userId: string; settings: UserSettings; categories: Category[]; initialDate: string; onSaved: () => Promise<void>; onClose: () => void; onFinish: (date: string) => void }
export function UnifiedTaskFlow(props: Props) {
  const context = useRuntime(), local = useLocalState()
  const [restored] = useState(() => {
    if (!context.restore || isUnifiedRecord(context.restore)) return context.restore
    return adaptRestoredUnified(context.restore, local.drafts, props.settings.timezone, props.settings.place?.id ?? '', today(props.settings.timezone))
  })
  const [initialRecord] = useState(() => isUnifiedRecord(restored) ? restored : local.drafts.find((row): row is UnifiedRecord => isUnifiedRecord(row) && row.value.definitionId === (restored?.value as { id?: string } | undefined)?.id))
  return <RuntimeContext.Provider value={{ ...context, restore: isUnifiedRecord(restored) ? null : restored }}><UnifiedEditor {...props} initialRecord={initialRecord} /></RuntimeContext.Provider>
}
function UnifiedEditor({ userId, settings, categories, onSaved, onClose, onFinish, initialRecord }: Props & { initialRecord?: UnifiedRecord }) {
  const { runtime, restore } = useRuntime(), local = useLocalState(), sync = useSyncState()
  const [record, setRecord] = useState(initialRecord), currentRecord = useRef(initialRecord)
  const key = restore?.key ?? initialRecord?.key ?? 'new-task'
  const [initial] = useState(() => initialRecord ? draftFromUnifiedIntent(initialRecord.value, today(settings.timezone)) : freshUnifiedDraft(settings.timezone, settings.place?.id ?? '', today(settings.timezone)))
  const draft = useVersionedDraft(userId, key, initial, restore ? restore.base : null)
  const { value, update } = draft
  const mounted = useRef(true), inFlight = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [review, setReview] = useState(false)
  const [screen, setScreen] = useState<'task' | 'advanced'>('task')
  const previousScreen = useRef(screen), settingsHeading = useRef<HTMLHeadingElement>(null), settingsButton = useRef<HTMLButtonElement>(null)
  const formView = useRef<HTMLFormElement>(null), badInputError = useRef<Error | null>(null)
  const settingsScreenId = useId(), summaryId = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (previousScreen.current === screen) return
    if (screen === 'task') settingsButton.current?.focus()
    else settingsHeading.current?.focus()
    previousScreen.current = screen
  }, [screen])
  const projection = sync.projection!, stage = record ? unifiedStage(projection, record.value) : 'definition'
  const committed = stage !== 'definition', done = stage === 'done'
  const occurrence = record ? projection.occurrences.get(record.value.occurrenceId.toLowerCase()) : undefined
  const rule = record?.value.schedule ? projection.recurrences.get(record.value.schedule.id.toLowerCase()) : undefined
  const blocked = busy || !!local.pending || !!local.storageError || !local.ready || sync.status !== 'ready'
  const summary = taskTimeSummary({ ...value, minutes: '', timing: { ...value.timing, startTime: '', endTime: '' } })
  function change(patch: Partial<UnifiedDraft>) { update({ ...value, ...patch }) }
  function navigate(next: typeof screen) {
    // Number inputs can expose value="" for a visible unfinished token (1e).
    // Keep its DOM mounted until it is corrected or deliberately cleared.
    const bad = Array.from(formView.current?.querySelectorAll<HTMLInputElement>('input') ?? []).find(input => input.validity.badInput)
    if (bad) {
      const failure = new Error('Завершите ввод числа или очистите поле перед переходом в другой раздел.')
      badInputError.current = failure; setError(failure)
      for (let parent = bad.parentElement; parent && parent !== formView.current; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
      }
      bad.focus(); bad.reportValidity()
      return
    }
    if (error === badInputError.current) setError(null)
    badInputError.current = null
    setScreen(next)
  }
  function intent(): UnifiedIntent {
    const startDate = value.timing.logicalDate || (value.repeat !== 'none' ? value.anchorDate : '')
    const timing = timeIntent(timingFromRange(value), startDate)
    const origin = workOrigin(value.minutes, timing)
    const definition: DefinitionFields = { ...constraints({ ...value, workOrigin: origin }), title: value.title, description: value.description, categoryId: value.categoryId || null, importance: value.importance, difficulty: value.difficulty, executionPriority: Number(value.executionPriority) }
    const preview = timingPreview(startDate || null, timing, definition.durationPolicy?.requiredWorkMinutes ?? null)
    if (preview.issue === 'workMismatch') throw new Error('Проверьте даты, часы и ручной объём. Конец должен быть позже начала, а полный интервал — соответствовать объёму.')
    const schedule = value.repeat === 'none' ? null : { id: value.ruleId, pattern: value.repeat === 'interval' ? 'interval' as const : 'weekly' as const, daysOfWeek: value.daysOfWeek, intervalDays: value.intervalDays, timezone: value.timing.timezone, startDate: validDate(startDate), endDate: value.endDate }
    if (schedule) scheduleInput(schedule, timing)
    return { definitionId: value.id, occurrenceId: value.occurrenceId, definition, logicalDate: value.timing.logicalDate || null, timeIntent: timing, schedule, definitionVersion: null }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    // Enter in settings is navigation, never implicit server Create.
    if (screen !== 'task') { navigate('task'); return }
    if (inFlight.current || blocked) return
    inFlight.current = true; setBusy(true); setError(null)
    const submitted = runtime.editors.get(key)?.()
    const current = () => mounted.current && runtime.current() && !!submitted && sameDraftRevision(runtime.editors.get(key)?.(), submitted)
    try {
      let captured: UnifiedIntent
      if (committed) captured = currentRecord.current!.value
      else {
        if (!value.title.trim() || codePointLength(value.title) > 200) throw new Error('Название должно содержать от 1 до 200 символов.')
        if (codePointLength(value.description) > 4000) throw new Error('Описание должно содержать не более 4000 символов.')
        captured = intent()
      }
      const next = prepareUnified(userId, captured, currentRecord.current)
      const success = await runUnifiedCreation(runtime, key, next, current, row => { currentRecord.current = row; if (mounted.current && runtime.current()) setRecord(row) })
      if (success && current()) {
        await onSaved()
        if (current()) { const fresh = runtime.coordinator.snapshot().projection?.occurrences.get(captured.occurrenceId.toLowerCase()); if (fresh?.logicalDate) onFinish(fresh.logicalDate) }
      }
    } catch (failure) { if (mounted.current && runtime.current()) setError(failure as Error) } finally { inFlight.current = false; if (mounted.current && runtime.current()) setBusy(false) }
  }
  return <Panel title="Новая задача" onClose={onClose}>
    {record && <p className="notice" role="status">{done ? 'Задача создана. Повторное нажатие не создаст копию.' : committed ? 'Описание сохранено. Продолжение осталось в этом браузере; новая копия задачи не создаётся.' : 'Создание сохранено в этом браузере. Если результат отправки неизвестен, повторите первоначальную отправку в восстановлении.'}</p>}
    <ErrorMessage error={error} />
    <form ref={formView} onSubmit={event => void submit(event)} onInvalidCapture={event => {
      // Native validation must be able to focus an invalid field even when
      // its disclosure has been collapsed. Opening it does not remount inputs.
      if (!(event.target instanceof HTMLElement)) return
      for (let parent = event.target.parentElement; parent && parent !== formView.current; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
      }
    }}>
      {screen !== 'task' ? <section className="task-time-screen" aria-labelledby={settingsScreenId}>
        <div className="task-time-heading">
          <h3 id={settingsScreenId} ref={settingsHeading} tabIndex={-1}>Расширенные настройки</h3>
          <button type="button" onClick={() => navigate('task')}>Назад к задаче</button>
        </div>
        {(blocked || committed) && <p className="notice" role="status">Настройки доступны для просмотра. Отправленные или уже подтверждённые данные остаются прежними.</p>}
        <p className="muted">Раскройте нужные разделы — можно открыть несколько или все сразу. Возврат к задаче сохраняет ввод в этом же редакторе и ничего не отправляет.</p>
        <div className="advanced-settings-menu">
          {(Object.keys(advancedScreens) as SettingsScreen[]).map(name => <details className="advanced-settings-section" key={name}>
            <summary>{advancedScreens[name]}</summary>
            <div className="advanced-settings-content">
              <TaskTimeSettings screen={name} value={value} onChange={update} categories={categories} placeName={settings.place?.name ?? 'не задано'} readOnly={blocked || committed} />
            </div>
          </details>)}
        </div>
        <div className="actions"><button className="primary" type="button" onClick={() => navigate('task')}>Готово</button></div>
      </section> : <>
        <fieldset disabled={blocked || committed}>
          <Field label="Название задачи">
            <input required value={value.title} onChange={event => change({ title: event.target.value })} />
          </Field>
          <Field label="Дата (необязательно)">
            <input type="date" value={value.timing.logicalDate} onChange={event => change({ timing: { ...value.timing, logicalDate: event.target.value } })} />
          </Field>
          <Field label="Время (необязательно)" hint="Например, 10:00 - 11:30. Одно время — только начало; - 11:30 — только конец. Для ночного интервала задайте день окончания в расширенных настройках.">
            <input type="text" autoComplete="off" spellCheck={false} placeholder="10:00 - 11:30" value={timeRangeText(value)} onChange={event => change({ timeRangeRaw: event.target.value })} />
          </Field>
          <Field label="Полный объём, минуты (необязательно)" hint="Пусто — объём по полному интервалу либо неизвестный объём. Ручной объём не сокращается.">
            <input type="number" min="1" max="2147483647" step="1" inputMode="numeric" value={value.minutes} onChange={event => change({ minutes: event.target.value, workOrigin: event.target.value ? 'manual' : 'unspecified' })} />
          </Field>
        </fieldset>
        <div className="task-time-summary">
          <button ref={settingsButton} type="button" aria-describedby={summaryId} onClick={() => navigate('advanced')}>Расширенные настройки</button>
          <p id={summaryId} className="muted">{summary.conditions}</p>
        </div>
        {!done && <button className="primary" type="submit" disabled={blocked}>{busy ? 'Создаём…' : committed ? 'Продолжить создание задачи' : 'Создать задачу'}</button>}
      </>}
      {!committed && <DraftStatus draft={draft} />}
    {screen === 'task' && committed && !done && record && <><button type="button" onClick={async () => { try { await runtime.coordinator.catchUp(); if (mounted.current && runtime.current()) setReview(true) } catch (failure) { if (mounted.current && runtime.current()) setError(failure as Error) } }}>Сравнить сохранённые условия</button>{review && <section className="conflict-review"><h3>Условия перед продолжением</h3><DefinitionSummary value={definitionSummaryValue(projection.definitions.get(record.value.definitionId.toLowerCase())!)} categories={categories} placeName={settings.place?.name ?? 'не задано'} /><h4>Первоначально выбранные условия</h4><DefinitionSummary value={definitionSummaryValue({ ...record.value.definition, id: record.value.definitionId, serverVersion: record.value.definitionVersion ?? "submitted" })} categories={categories} placeName={settings.place?.name ?? "не задано"} /><p>Выбранные часы и повторение сохранятся. Новое продолжение использует эту редакцию условий.</p><button type="button" disabled={blocked} onClick={async () => { try { const fresh = runtime.coordinator.snapshot().projection!.definitions.get(record.value.definitionId.toLowerCase())!; const next = prepareUnified(userId, { ...record.value, definitionVersion: fresh.serverVersion }, currentRecord.current); await runtime.saveDraftAndWait(next); if (mounted.current && runtime.current()) { currentRecord.current = next; setRecord(next); setReview(false); setError(null) } } catch (failure) { setError(failure as Error) } }}>Использовать эту редакцию как базу</button></section>}</>}
    </form>
    {screen === 'task' && occurrence && <OccurrenceSummary occurrence={occurrence} settings={settings} />}{screen === 'task' && rule && <RecurrenceSummary rule={rule} />}
    {screen === 'task' && done && !record?.value.schedule && !occurrence?.logicalDate && <p className="notice">Задача без даты доступна в разделе «Задачи» с периодом «Все» или «Без даты».</p>}{screen === 'task' && done && <button type="button" onClick={() => void runtime.requestLeave(onClose)}>Готово</button>}
  </Panel>
}

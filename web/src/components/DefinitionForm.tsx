import { useRef, useState, type FormEvent } from 'react'
import { confirmedRead, useRuntime } from '../sync/context'
import type { Category, DefinitionResponse, DefinitionFields, TaskDefinition, UserSettings } from '../api/types'
import { codePointLength } from '../lib/operations'
import { ConstraintsForm, constraintDraft, constraints, defaultConstraints, type ConstraintsDraft } from './ConstraintsForm'
import { CommandStatus, DraftStatus, ConflictReview, Field, Panel, SubmitButton, canRebase, useCommand, useVersionedDraft } from './shared'
import { DefinitionSummary, definitionSummaryValue } from './RecordSummary'
import { afterRefresh } from '../lib/command-lifecycle'
import { resolvedCreationStart, type CreationStart } from '../lib/creation'
import { OffsetSelect } from './AvailabilityForm'
import type { RecurrenceDraft } from '../lib/recurrence'
import { RecurrenceFields } from './RecurrenceFields'

interface DefinitionDraft extends ConstraintsDraft { id: string; title: string; description: string; categoryId: string; importance: DefinitionFields['importance']; difficulty: DefinitionFields['difficulty']; executionPriority: string; firstOccurrenceDate: string; firstLocalStart?: string; firstTimezone?: string; firstUtcOffset?: string; recurrence?: RecurrenceDraft }
export function DefinitionForm({ userId, definition, settings, categories, moreCategories, onMoreCategories, onSaved, onClose, initialDate, creationDefinitionId, onPrepare, initialStart, recurring, creationCommitted = false }: { userId: string; definition?: TaskDefinition; settings: UserSettings; categories: Category[]; moreCategories: boolean; onMoreCategories: () => void; onSaved: () => Promise<void>; onClose: () => void; initialDate?: string; creationDefinitionId?: string; initialStart?: CreationStart | null; onPrepare?: (definitionId: string, start: CreationStart) => Promise<void>; creationCommitted?: boolean; recurring?: { initial: RecurrenceDraft; prepare: (definitionId: string, schedule: RecurrenceDraft) => Promise<void> } }) {
  const { runtime, restore } = useRuntime()
  const key = definition ? `definition:${definition.id}` : recurring ? 'new-recurring-definition' : 'new-definition'
  const [review, setReview] = useState<TaskDefinition | null>(null)
  const initial: DefinitionDraft = definition ? { ...constraintDraft(definition), id: definition.id, title: definition.title, description: definition.description, categoryId: definition.categoryId ?? '', importance: definition.importance, difficulty: definition.difficulty, executionPriority: String(definition.executionPriority), firstOccurrenceDate: '' } : { ...defaultConstraints(settings.timezone, settings.place?.id ?? ''), id: creationDefinitionId ?? crypto.randomUUID(), title: '', description: '', categoryId: '', importance: 'normal', difficulty: 'medium', executionPriority: '3', firstOccurrenceDate: initialDate ?? '', firstLocalStart: initialStart === null ? '' : initialStart?.localStart ?? '', firstTimezone: initialStart?.timezone ?? settings.timezone, firstUtcOffset: initialStart?.utcOffset ?? '', recurrence: recurring?.initial }
  const draft = useVersionedDraft(userId, key, initial, definition)
  const { value, base, update: setValue } = draft
  const selectedLocalStart = value.firstLocalStart ?? (initialStart === null || (restore?.key === key && !definition && !initialStart) ? '' : initialStart?.localStart ?? '')
  const preparingRef = useRef(false)
  const [preparing, setPreparing] = useState(false)
  const command = useCommand(userId, key, current => afterRefresh(current, draft.clear, onSaved, onPrepare || recurring ? undefined : onClose))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (preparingRef.current || creationCommitted) return
    preparingRef.current = true; setPreparing(true)
    try {
      if (!value.title.trim() || codePointLength(value.title) > 200) throw new Error('Название задачи должно содержать от 1 до 200 символов.')
      if (codePointLength(value.description) > 4000) throw new Error('Описание должно содержать не более 4000 символов.')
      const body: DefinitionFields = { ...constraints(value), title: value.title, description: value.description, categoryId: value.categoryId || null, importance: value.importance, difficulty: value.difficulty, executionPriority: Number(value.executionPriority) }
      if (!base && recurring) { await recurring.prepare(value.id, value.recurrence ?? recurring.initial) } else if (!base && onPrepare) {
        const localStart = selectedLocalStart
        const start = resolvedCreationStart({ localStart, timezone: value.firstTimezone ?? initialStart?.timezone ?? settings.timezone, utcOffset: value.firstUtcOffset ?? initialStart?.utcOffset ?? '' })
        await onPrepare(value.id, start)
      }
      await command.submit({ method: base ? 'PUT' : 'POST', path: base ? `/task-definitions/${base.id}` : '/task-definitions', ...(base ? { version: base.serverVersion } : {}), body: { ...body, ...(base ? {} : { id: value.id }) } })
    } catch (error) { command.setError(error as Error) } finally { preparingRef.current = false; setPreparing(false) }
  }
  async function rebase() {
    if (!base) return
    try { setReview((await confirmedRead<DefinitionResponse>(runtime, `/task-definitions/${base.id}`)).definition) } catch (error) { command.setError(error as Error) }
  }
  return <Panel title={definition ? 'Изменить задачу' : 'Новая задача'} onClose={onClose}>
    <p className="muted">Описание и условия задачи применяются к новым выполнениям. Уже созданные выполнения сохраняют свои ограничения.</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={!base && (!!onPrepare || !!recurring) && (preparing || command.busy || !!command.pending)}>
        <Field label="Название задачи">
          <input required value={value.title} onChange={event => setValue({ ...value, title: event.target.value })} />
        </Field>
        <Field label="Описание (необязательно)">
          <textarea rows={3} value={value.description} onChange={event => setValue({ ...value, description: event.target.value })} />
        </Field>
        {!base && recurring && <RecurrenceFields value={value.recurrence ?? recurring.initial} onChange={recurrence => setValue({ ...value, recurrence })} />}
        {!base && !recurring && <div className="form-grid">
          <Field label="Начало выполнения" hint="Выбранные дата и время сохранятся для последующего подтверждения размещения.">
            <input type="datetime-local" required step="60" value={selectedLocalStart} onChange={event => setValue({ ...value, firstLocalStart: event.target.value, firstOccurrenceDate: event.target.value.slice(0, 10), firstUtcOffset: '' })} />
          </Field>
          <Field label="Часовой пояс начала">
            <input required list="timezones" value={value.firstTimezone ?? initialStart?.timezone ?? settings.timezone} onChange={event => setValue({ ...value, firstTimezone: event.target.value, firstUtcOffset: '' })} />
          </Field>
          <OffsetSelect
            label="Начало при переводе часов"
            date={selectedLocalStart.slice(0, 10)}
            time={selectedLocalStart.slice(11, 16)}
            timezone={value.firstTimezone ?? initialStart?.timezone ?? settings.timezone}
            value={value.firstUtcOffset ?? initialStart?.utcOffset ?? ''}
            onChange={firstUtcOffset => setValue({ ...value, firstUtcOffset })}
          />
        </div>}
        <ConstraintsForm value={value} onChange={next => setValue({ ...value, ...next })} placeName={settings.place?.name ?? 'не задано'}>
          <div className="form-grid">
            <Field label="Категория">
              <select value={value.categoryId} onChange={event => setValue({ ...value, categoryId: event.target.value })}>
                <option value="">Без категории</option>
                {value.categoryId && !categories.some(category => category.id === value.categoryId) && <option value={value.categoryId}>Сохранённая категория · загрузите остальные</option>}
                {categories.map(category => <option value={category.id} key={category.id}>{category.name}</option>)}
              </select>
            </Field>
            <Field label="Важность">
              <select value={value.importance} onChange={event => setValue({ ...value, importance: event.target.value as DefinitionFields['importance'] })}>
                <option value="low">Низкая</option>
                <option value="normal">Обычная</option>
                <option value="high">Высокая</option>
              </select>
            </Field>
            <Field label="Сложность">
              <select value={value.difficulty} onChange={event => setValue({ ...value, difficulty: event.target.value as DefinitionFields['difficulty'] })}>
                <option value="light">Лёгкая</option>
                <option value="medium">Средняя</option>
                <option value="heavy">Тяжёлая</option>
              </select>
            </Field>
            <Field label="Приоритет" hint="От 1 до 5: большее число — выше приоритет.">
              <select value={value.executionPriority} onChange={event => setValue({ ...value, executionPriority: event.target.value })}>
                {[1, 2, 3, 4, 5].map(priority => <option key={priority}>{priority}</option>)}
              </select>
            </Field>
          </div>
          {moreCategories && <button type="button" onClick={onMoreCategories}>Загрузить ещё категории</button>}
        </ConstraintsForm>
        <SubmitButton busy={command.busy || preparing} disabled={command.blocked || creationCommitted}>
          {base ? 'Сохранить на сервере' : 'Создать задачу'}
        </SubmitButton>
      </fieldset>
      <DraftStatus draft={draft} />
      <CommandStatus command={command} />
      {base && (canRebase(command.problem) || draft.changed) && <button type="button" onClick={() => void rebase()}>Проверить актуальную редакцию</button>}
      {review && <ConflictReview
        current={<DefinitionSummary value={definitionSummaryValue(review)} categories={categories} placeName={settings.place?.name ?? 'не задано'} />}
        draft={<DefinitionSummary value={value} categories={categories} placeName={settings.place?.name ?? 'не задано'} />}
        onAccept={() => { draft.rebase(review); setReview(null); command.setError(null) }}
        onCancel={() => setReview(null)}
      />}
    </form>
  </Panel>
}

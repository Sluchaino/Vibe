import { useState, type FormEvent } from 'react'
import { confirmedRead, useRuntime } from '../sync/context'
import type { SettingsResponse, UserSettings } from '../api/types'
import { codePointLength } from '../lib/operations'
import { isTimezone } from '../lib/time'
import { CommandStatus, DraftStatus, ConflictReview, Field, Panel, SubmitButton, canRebase, useCommand, useVersionedDraft } from './shared'
import { SettingsSummary } from './RecordSummary'

export function SettingsForm({ userId, settings, onSaved }: { userId: string; settings: UserSettings; onSaved: () => Promise<void> }) {
  const { runtime } = useRuntime()
  const draft = useVersionedDraft(userId, 'settings', { timezone: settings.timezone, name: settings.place?.name ?? '', placeId: settings.place?.id ?? crypto.randomUUID() }, settings)
  const { value, base, update: setValue } = draft
  const [review, setReview] = useState<UserSettings | null>(null)
  const command = useCommand(userId, 'settings', async current => {
    await onSaved()
    if (!current()) return
    const fresh = runtime.coordinator.snapshot().projection?.settings
    if (fresh) draft.finish({ timezone: fresh.timezone, name: fresh.place?.name ?? '', placeId: fresh.place?.id ?? value.placeId }, fresh)
  })
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!isTimezone(value.timezone)) { command.setError(new Error('Укажите действительную IANA-зону, например Europe/Moscow.')); return }
    if (!value.name.trim() || codePointLength(value.name) > 100) { command.setError(new Error('Название места должно содержать от 1 до 100 символов.')); return }
    await command.submit({ method: 'PUT', path: '/settings', version: base.serverVersion, body: { timezone: value.timezone, weekStartsOn: 'monday', place: { id: base.place?.id ?? value.placeId, name: value.name } } })
  }
  async function rebase() {
    try { setReview((await confirmedRead<SettingsResponse>(runtime, '/settings')).settings) } catch (error) { command.setError(error as Error) }
  }
  return <Panel title="Ваше место и часовой пояс"><p className="muted">Начало недели — понедельник. Смена зоны меняет отображение календаря, сохраняя абсолютное время существующих блоков.</p><form onSubmit={event => void submit(event)}><fieldset><div className="form-grid"><Field label="Название единственного места" hint="Например, Дом или Рабочий кабинет. После выбора место можно переименовать."><input required value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} autoComplete="off" /></Field><Field label="Часовой пояс календаря" hint="IANA, например Europe/Moscow или Europe/Berlin."><input required list="timezones" value={value.timezone} onChange={event => setValue({ ...value, timezone: event.target.value })} autoComplete="off" /></Field></div><SubmitButton busy={command.busy} disabled={command.blocked} /></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} />{(canRebase(command.problem) || draft.changed) && <button type="button" onClick={() => void rebase()}>Проверить актуальную редакцию</button>}{review && <ConflictReview current={<SettingsSummary timezone={review.timezone} name={review.place?.name ?? ''} />} draft={<SettingsSummary timezone={value.timezone} name={value.name} />} onAccept={() => { draft.rebase(review); setReview(null); command.setError(null) }} onCancel={() => setReview(null)} />}</form></Panel>
}

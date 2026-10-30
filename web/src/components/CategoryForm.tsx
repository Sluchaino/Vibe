import type { FormEvent } from 'react'
import { codePointLength } from '../lib/operations'
import { CommandStatus, DraftStatus, Field, SubmitButton, useCommand, useVersionedDraft } from './shared'
import { afterRefresh } from '../lib/command-lifecycle'

export function CategoryForm({ userId, onSaved }: { userId: string; onSaved: () => Promise<void> }) {
  const draft = useVersionedDraft(userId, 'new-category', { name: '', id: crypto.randomUUID() }, null)
  const { value, update: setValue, clear } = draft
  const command = useCommand(userId, 'new-category', current => afterRefresh(current, () => { clear(); setValue({ name: '', id: crypto.randomUUID() }) }, onSaved))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!value.name.trim() || codePointLength(value.name) > 100) { command.setError(new Error('Название категории должно содержать от 1 до 100 символов.')); return }
    await command.submit({ method: 'POST', path: '/categories', body: { id: value.id, name: value.name } })
  }
  return <form className="compact-form" onSubmit={event => void submit(event)}><fieldset><Field label="Новая категория"><input required value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></Field><SubmitButton busy={command.busy} disabled={command.blocked}>Добавить категорию</SubmitButton></fieldset><DraftStatus draft={draft} /><CommandStatus command={command} /></form>
}

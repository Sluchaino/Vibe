import type { FormEvent } from 'react'
import { codePointLength } from '../lib/operations'
import { CommandStatus, Field, SubmitButton, useCommand, useDraft } from './shared'
import { afterRefresh } from '../lib/command-lifecycle'

export function CategoryForm({ userId, onSaved }: { userId: string; onSaved: () => Promise<void> }) {
  const [value, setValue, clear] = useDraft(userId, 'new-category', { name: '', id: crypto.randomUUID() })
  const command = useCommand(userId, 'new-category', current => afterRefresh(current, () => { clear(); setValue({ name: '', id: crypto.randomUUID() }) }, onSaved))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!value.name.trim() || codePointLength(value.name) > 100) { command.setError(new Error('Название категории должно содержать от 1 до 100 символов.')); return }
    await command.submit({ method: 'POST', path: '/categories', body: { id: value.id, name: value.name } })
  }
  return <form className="compact-form" onSubmit={event => void submit(event)}><fieldset><Field label="Новая категория"><input required value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></Field><SubmitButton busy={command.busy} disabled={command.blocked}>Добавить категорию</SubmitButton></fieldset><CommandStatus command={command} /></form>
}

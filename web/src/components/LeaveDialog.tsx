import { useEffect, useRef, useState } from 'react'
import { useLocalState, useRuntime } from '../sync/context'
import { ErrorMessage } from './shared'

export function LeaveDialog() {
  const { runtime } = useRuntime(), local = useLocalState()
  const element = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { const dialog = element.current; if (local.leaveRequested && !dialog?.open) dialog?.showModal(); else if (!local.leaveRequested && dialog?.open) dialog.close() }, [local.leaveRequested])
  async function choose(choice: 'save' | 'discard' | 'continue') { if (busy) return; setBusy(true); try { await runtime.decideLeave(choice) } finally { setBusy(false) } }
  return <dialog ref={element} className="leave-dialog" aria-labelledby="leave-title" onCancel={event => { event.preventDefault(); if (!busy) void choose('continue') }}><h2 id="leave-title">Сохранить черновик?</h2><p>Есть новая несохранённая задача или изменённый ввод. Сохранение обновит этот же черновик в браузере. Отправленные команды и уже созданные данные сохранятся при любом выборе.</p><ErrorMessage error={local.leaveError} /><div className="actions"><button type="button" className="primary" disabled={busy} onClick={() => void choose('save')}>Сохранить черновик и выйти</button><button type="button" disabled={busy} onClick={() => void choose('discard')}>Не сохранять</button><button type="button" disabled={busy} onClick={() => void choose('continue')}>Продолжить редактирование</button></div></dialog>
}

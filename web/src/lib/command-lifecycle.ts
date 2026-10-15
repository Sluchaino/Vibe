import type { PendingCommand } from './operations.ts'
import type { IdentityState } from '../state/session.ts'
import { ApiError, IdentityChangedError, NetworkError } from '../api/client.ts'

export interface CommandTicket { command: PendingCommand; epoch: number; sequence: number }
export type CurrentCommandGuard = () => boolean

// One form's synchronous in-flight guard plus identity/request/mount guards.
// Storage is shared across reopened forms; removal always compares the opId.
export class CommandLifecycle {
  private mounted = false
  private sequence = 0
  private active: CommandTicket | null = null
  constructor(privateUserId: string, privateKey: string, privateState: IdentityState) {
    this.userId = privateUserId; this.key = privateKey; this.state = privateState
  }
  private userId: string
  private key: string
  private state: IdentityState
  mount() { this.mounted = true }
  unmount() { this.mounted = false; this.sequence++; this.active = null }
  get inFlight() { return this.active !== null }
  stored() { return this.state.getDraft<PendingCommand>(this.userId, this.key) }
  begin(command: PendingCommand): CommandTicket | null {
    if (!this.mounted || this.inFlight || this.state.userId !== this.userId || command.userId !== this.userId) return null
    const stored = this.stored()
    if (stored && stored.opId !== command.opId) return null
    const ticket = { command, epoch: this.state.epoch, sequence: ++this.sequence }
    this.active = ticket
    this.state.setDraft(this.userId, this.key, command)
    return ticket
  }
  current(ticket: CommandTicket) {
    const stored = this.stored()
    return this.mounted && this.active === ticket && this.sequence === ticket.sequence && this.state.epoch === ticket.epoch && this.state.userId === this.userId && (!stored || stored.opId === ticket.command.opId)
  }
  ownsIdentity(ticket: CommandTicket) { return this.state.epoch === ticket.epoch && this.state.userId === this.userId }
  clearPending(ticket: CommandTicket) {
    if (this.stored()?.opId !== ticket.command.opId) return false
    this.state.clearDraft(this.userId, this.key)
    return true
  }
  fail(ticket: CommandTicket, error: Error) {
    const uncertain = error instanceof NetworkError || error instanceof IdentityChangedError || (error instanceof ApiError && (error.problem.status === 401 || error.problem.status >= 500))
    if (!uncertain) this.clearPending(ticket)
  }
  end(ticket: CommandTicket) { if (this.active === ticket) this.active = null }
}

// The guard must be rechecked after refresh: the user may close/switch the
// editor while the read awaits. No late callback closes a different editor.
export async function afterRefresh(current: CurrentCommandGuard, before: () => void, refresh: () => Promise<void> | void, after?: () => void) {
  if (!current()) return
  before()
  await refresh()
  if (current()) after?.()
}
export async function settleAcknowledgement(lifecycle: CommandLifecycle, ticket: CommandTicket, afterSuccess: (current: CurrentCommandGuard) => Promise<void> | void, onAcknowledged?: () => void) {
  const acknowledged = lifecycle.clearPending(ticket)
  const current = () => lifecycle.current(ticket)
  let refreshed = false
  let refreshError: Error | null = null
  if (lifecycle.ownsIdentity(ticket)) {
    if (acknowledged && current()) onAcknowledged?.()
    try { await afterSuccess(current); refreshed = lifecycle.ownsIdentity(ticket) } catch (error) { refreshError = error instanceof Error ? error : new Error('Не удалось обновить данные.') }
  }
  return { success: acknowledged && refreshed && current(), current: current(), refreshError }
}

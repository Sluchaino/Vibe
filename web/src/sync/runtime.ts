import { ApiError, IdentityChangedError, mutate } from '../api/client.ts'
import { captureCommand, type Command, type PendingCommand } from '../lib/operations.ts'
import { identityState } from '../state/session.ts'
import { openStorage, type DraftRecord, type PendingRecord, type StoragePort } from '../persistence/database.ts'
import { SyncCoordinator } from './coordinator.ts'
import { DraftSession, DraftConflictError } from '../lib/draft-session.ts'

export interface LocalState { drafts: DraftRecord[]; pending: PendingRecord | null; storageError: Error | null; ready: boolean; busy: boolean; leaveRequested: boolean; leaveError: Error | null }
export const pendingLabels = { unconfirmed: 'Осталась неподтверждённая отправка', acknowledgedRefresh: 'Сохранено, ожидается обновление', conflict: 'Изменения требуют сравнения', rejected: 'Изменения отклонены', resetReview: 'Источник данных восстановлен — проверьте отправку' }
export function freezePending(command: PendingCommand, draft: DraftRecord, streamId: string): PendingRecord {
  return { userId: command.userId, opId: command.opId, command: structuredClone(command), query: command.path.includes('?') ? command.path.slice(command.path.indexOf('?') + 1) : '', ifMatch: command.version ? `"${command.version}"` : null, draftId: draft.draftId, draftRevision: draft.revision, submittedDraft: structuredClone(draft), recoveryDraftId: `pending:${command.opId}`, recoveryRevision: 1, streamId, pendingRevision: 1, status: 'unconfirmed' }
}
export function needsReset(record: PendingRecord, streamId: string) { return (record.authorizedStream ?? record.streamId) !== streamId && record.status !== 'resetReview' }
export function uncertainFailure(error: unknown) { return !(error instanceof ApiError) || ![400, 404, 409, 412, 428].includes(error.problem.status) }

// This account runtime owns durable coordination, never confirmed data. The
// coordinator alone publishes projections; mutation payloads are intentionally ignored.
export class AccountRuntime {
  readonly coordinator: SyncCoordinator
  readonly editors = new Map<string, () => DraftRecord>()
  readonly sessions = new Set<DraftSession>()
  readonly tabId = crypto.randomUUID()
  private leaving: { action: () => unknown; resolve: (allowed: boolean) => void } | null = null
  private local: LocalState = { drafts: [], pending: null, storageError: null, ready: false, busy: false, leaveRequested: false, leaveError: null }
  private listeners = new Set<() => void>()
  private epoch = identityState.epoch
  private closed = false
  private delivering = false
  private reloading = 0
  private storagePromise: Promise<StoragePort>
  private open: () => Promise<StoragePort>
  private opened: StoragePort | null = null
  private channel: BroadcastChannel | undefined
  private unsubscribe: (() => void) | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  readonly userId: string
  private sender: (command: PendingCommand, guard: () => void) => Promise<unknown>
  constructor(userId: string, storage?: Promise<StoragePort>, coordinator?: SyncCoordinator, sender: (command: PendingCommand, guard: () => void) => Promise<unknown> = mutate, reopen?: () => Promise<StoragePort>) {
    this.userId = userId; this.sender = sender
    this.coordinator = coordinator ?? new SyncCoordinator(userId)
    this.open = reopen ?? (() => openStorage())
    this.storagePromise = storage ?? this.open()
    // Observe rejected opens even before start; failed storage must not affect reads.
    this.storagePromise.catch(() => undefined)
  }
  current = () => !this.closed && identityState.userId === this.userId && identityState.epoch === this.epoch
  snapshot = () => this.local
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<LocalState>) { if (!this.current()) return; this.local = { ...this.local, ...patch }; for (const listener of this.listeners) listener() }
  private storageFailure(error: unknown) { this.publish({ storageError: error instanceof Error ? error : new Error('Локальное сохранение недоступно.') }) }
  private async storage() { try { this.opened = await this.storagePromise; return this.opened } catch (error) { this.storageFailure(error); throw error } }
  async reload() {
    const generation = ++this.reloading
    try {
      const storage = await this.storage()
      const [drafts, pending] = await Promise.all([storage.drafts(this.userId), storage.getPending(this.userId)])
      if (generation !== this.reloading) return
      this.publish({ drafts, pending, ready: true })
    } catch (error) { this.storageFailure(error) }
  }
  async latestDraft(draftId: string) { const rows = await (await this.storage()).drafts(this.userId); if (!this.current()) throw new IdentityChangedError('Сеанс изменился.'); return rows.find(row => row.draftId === draftId) }
  private notify(serverChanged = false) { this.channel?.postMessage({ serverChanged }); void this.reload() }
  createSession(key: string, value: unknown, base: unknown, restored: DraftRecord | null) { return new DraftSession(this.userId, key, value, base, restored?.key === key && restored.userId === this.userId ? restored : null, () => this.storage(), () => { this.publish({}); this.notify() }, this.tabId) }
  hasUnsaved() { return [...this.sessions].some(session => session.needsLeave) }
  requestCreationModeChange(action: () => unknown): Promise<boolean> {
    if (!this.current() || this.leaving) return Promise.resolve(false)
    // Switching the kind of an untouched new form is still part of starting
    // creation. Close/logout keep their existing pristine-new-task guard.
    if ([...this.sessions].some(session => session.dirty)) return this.requestLeave(action)
    return Promise.resolve(action()).then(() => true)
  }
  requestLeave(action: () => unknown): Promise<boolean> {
    if (!this.current()) return Promise.resolve(false)
    if (!this.hasUnsaved()) return Promise.resolve(action()).then(() => true)
    if (this.leaving) return Promise.resolve(false)
    return new Promise(resolve => { this.leaving = { action, resolve }; this.publish({ leaveRequested: true, leaveError: null }) })
  }
  async decideLeave(choice: 'save' | 'discard' | 'continue') {
    const leaving = this.leaving
    if (!leaving) return
    if (choice === 'continue') { this.leaving = null; this.publish({ leaveRequested: false, leaveError: null }); leaving.resolve(false); return }
    try {
      for (const session of this.sessions) if (session.needsLeave) { if (choice === 'save') await session.save(); else await session.discard() }
      if (!this.current() || this.leaving !== leaving) return
      if (this.hasUnsaved()) { this.publish({ leaveError: new Error('Во время сохранения появился новый ввод. Проверьте его перед выходом.') }); return }
      this.leaving = null; this.publish({ leaveRequested: false, leaveError: null })
      await leaving.action(); leaving.resolve(true)
    } catch (error) { this.publish({ leaveError: error instanceof Error ? error : new Error('Не удалось сохранить черновик.') }); if (this.leaving !== leaving) leaving.resolve(false) }
  }
  private beforeUnload = (event: BeforeUnloadEvent) => { if ([...this.sessions].some(session => session.dirty)) { event.preventDefault(); event.returnValue = '' } }
  saveDraft(draft: DraftRecord) { void this.storage().then(storage => storage.saveDraft(draft)).then(() => { this.publish({ storageError: null }); this.notify() }).catch(error => this.storageFailure(error)) }
  async saveDraftAndWait(draft: DraftRecord) {
    if (!this.current() || draft.userId !== this.userId) throw new IdentityChangedError('Сеанс изменился. Ввод сохранён для исходного аккаунта.')
    try {
      const storage = await this.storage()
      if (!this.current()) throw new IdentityChangedError('Сеанс изменился. Отправка остановлена.')
      const expected = Object.hasOwn(draft, 'expectedRevision') ? draft.expectedRevision ?? null : draft.revision === 1 ? null : draft.revision - 1
      if (!await storage.saveDraftCas({ ...draft, category: 'continuation', expectedRevision: draft.revision }, expected)) throw new DraftConflictError()
      if (!this.current()) throw new IdentityChangedError('Сеанс изменился. Продолжение доступно исходному аккаунту.')
      this.publish({ storageError: null }); this.notify()
    } catch (error) { if (!(error instanceof IdentityChangedError)) this.storageFailure(error); throw error }
  }
  async retryStorage() {
    this.opened?.close(); this.opened = null
    this.storagePromise = this.open()
    this.storagePromise.catch(() => undefined)
    await this.storage()
    for (const session of this.sessions) await session.retryEmergency()
    this.publish({ storageError: null }); await this.reload()
  }
  async start() {
    if (!this.current()) return
    if (typeof BroadcastChannel !== 'undefined') { this.channel = new BroadcastChannel('vibe-s1'); this.channel.onmessage = event => { void this.reload(); if (event.data?.serverChanged === true) void this.coordinator.catchUp().catch(() => undefined) } }
    this.unsubscribe = this.coordinator.subscribe(() => { const sync = this.coordinator.snapshot(); if (sync.status === 'ready' && !sync.busy) void this.reconcile().catch(error => this.storageFailure(error)) })
    this.coordinator.start()
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.beforeUnload)
    await this.reload()
    if (!this.current()) return
    this.interval = setInterval(() => { void this.reload() }, 5000)
  }
  stop() { this.closed = true; this.leaving?.resolve(false); this.leaving = null; this.coordinator.stop(); this.unsubscribe?.(); this.channel?.close(); clearInterval(this.interval); if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.beforeUnload); void this.storagePromise.then(storage => storage.close()).catch(() => undefined) }
  assertDispatch = () => {
    const sync = this.coordinator.snapshot()
    if (!this.current()) throw new IdentityChangedError('Сеанс изменился. Отправка сохранена для исходного аккаунта.')
    if (!this.local.ready || this.local.storageError) throw this.local.storageError ?? new Error('Локальное хранилище ещё не готово.')
    const failedDraft = [...this.sessions].find(session => session.error && !(session.error instanceof DraftConflictError))
    if (failedDraft) throw failedDraft.error
    if (sync.status !== 'ready' || !sync.projection) throw new Error('Сначала дождитесь успешного обновления данных. Ввод сохранён.')
  }
  async reconcile() {
    if (!this.current()) return
    const sync = this.coordinator.snapshot()
    if (sync.status !== 'ready' || sync.busy || !sync.projection) return
    const storage = await this.storage(), pending = await storage.getPending(this.userId)
    if (pending && needsReset(pending, sync.projection.streamId)) {
      await storage.transition(pending, { status: 'resetReview', previousStatus: pending.status })
      this.notify()
    } else if (pending?.status === 'acknowledgedRefresh' && !this.delivering) {
      // Reload/crash recovery never replays an already acknowledged command.
      await this.retry()
    }
  }
  async submit(key: string, input: Command, evidence?: { value: unknown; base: unknown }): Promise<{ success: boolean; draft?: DraftRecord }> {
    if (this.delivering) throw new Error('Сначала дождитесь текущей отправки.')
    this.delivering = true; this.publish({ busy: true })
    try {
      this.assertDispatch()
      const command = captureCommand(this.userId, input)
      const draft = structuredClone(this.editors.get(key)?.() ?? { userId: this.userId, draftId: crypto.randomUUID(), key, value: evidence?.value ?? {}, base: evidence?.base ?? null, revision: 1, updatedAt: Date.now() })
      const storage = await this.storage()
      this.assertDispatch()
      const frozen = freezePending(command, draft, this.coordinator.snapshot().projection!.streamId)
      // reserve() resolves only on IDB transaction completion, before any fetch.
      if (!await storage.reserve(frozen, draft)) { await this.reload(); throw new Error('В этом браузере осталась другая отправка. Разрешите её в разделе «Сохранённое в браузере»; этот ввод сохранён.') }
      this.notify()
      return { success: await this.deliver(frozen), draft }
    } catch (error) { await this.reload(); throw error }
    finally { this.delivering = false; this.publish({ busy: false }) }
  }
  async retry(explicitReset = false) {
    if (this.delivering) return false
    this.delivering = true; this.publish({ busy: true })
    try {
      this.assertDispatch()
      // Verify current server state first, preserving the original frozen intent.
      await this.coordinator.catchUp()
      const storage = await this.storage()
      let pending = await storage.getPending(this.userId)
      if (!pending) return true
      const stream = this.coordinator.snapshot().projection!.streamId
      if (needsReset(pending, stream)) { await storage.transition(pending, { status: 'resetReview', previousStatus: pending.status }); pending = await storage.getPending(this.userId); this.notify() }
      if (!pending) return false
      if (pending.status === 'resetReview') {
        if (!explicitReset) throw new Error('Источник данных изменился. Проверьте исходную отправку и явно разрешите её повтор.')
        if (!await storage.transition(pending, { status: 'unconfirmed', authorizedStream: stream })) return false
        pending = (await storage.getPending(this.userId))!
      }
      if (pending.status === 'conflict' || pending.status === 'rejected') throw new Error('Сначала сравните сохранённый ввод с актуальной редакцией и разрешите отказ.')
      return await this.deliver(pending)
    } finally { this.delivering = false; this.publish({ busy: false }); await this.reload() }
  }
  private async deliver(original: PendingRecord) {
    const storage = await this.storage()
    const stored = await storage.getPending(this.userId)
    if (!stored || stored.opId !== original.opId || stored.pendingRevision !== original.pendingRevision || stored.status !== original.status) { this.notify(); return false }
    let pending = stored
    const submittedDraft = stored.submittedDraft
    let acknowledgedHere = false
    const assertFrozen = () => {
      this.assertDispatch()
      if ((pending.authorizedStream ?? pending.streamId) !== this.coordinator.snapshot().projection!.streamId) throw new Error('Источник данных изменился. Нужна отдельная проверка исходной отправки.')
    }
    if (pending.status === 'unconfirmed') {
      try {
        assertFrozen()
        await this.sender(pending.command, assertFrozen)
        acknowledgedHere = true
      } catch (error) {
        if (!uncertainFailure(error)) {
          const problem = (error as ApiError).problem
          await storage.transition(pending, { status: [409, 412, 428].includes(problem.status) ? 'conflict' : 'rejected', problem })
          this.notify()
          // A final error also requires a new post-response tail, never merges
          // currentEntity carried in a ProblemDetails body.
          if (this.current()) await this.coordinator.catchUp().catch(() => undefined)
        }
        this.notify(); throw error
      }
      const marked = await storage.transition(pending, { status: 'acknowledgedRefresh' })
      const acknowledged: PendingRecord = { ...pending, status: 'acknowledgedRefresh', pendingRevision: pending.pendingRevision + 1 }
      if (marked) pending = acknowledged
      else {
        // An explicit retry in another tab may receive the same HTTP ACK and
        // transition/release the slot while our original HTTP is still pending.
        const peer = await storage.getPending(this.userId)
        if (!this.current()) { this.notify(); return false }
        if (peer?.opId === pending.opId) {
          const sameCommand = JSON.stringify(peer.command) === JSON.stringify(pending.command) && peer.ifMatch === pending.ifMatch && peer.query === pending.query
          if (peer.status !== 'acknowledgedRefresh' || !sameCommand || (peer.authorizedStream ?? peer.streamId) !== (pending.authorizedStream ?? pending.streamId)) { this.notify(); return false }
          pending = peer
        } else pending = acknowledged
        // This local token is evidence of our own received ACK, not a write or
        // adoption of a newer slot. It must still pass a fresh post-ACK tail.
      }
      this.notify(true)
    }
    if (pending.status !== 'acknowledgedRefresh' || !this.current()) return false
    await this.coordinator.catchUp() // Strict new tail barrier, after ACK.
    if (!this.current()) return false
    const stream = this.coordinator.snapshot().projection!.streamId
    if (needsReset(pending, stream)) { await storage.transition(pending, { status: 'resetReview', previousStatus: pending.status }); this.notify(); return false }
    const released = await storage.transition(pending, null, true)
    let peerFinished = false, acknowledgeSource = released
    if (!released && acknowledgedHere) {
      // Another tab may have read this known ACK, obtained its own fresh tail,
      // and released the shared slot before this sender's tail finished.
      // Absence alone is not evidence: this branch requires our HTTP ACK plus
      // the post-ACK barrier above, with the same current owner and stream.
      const replacement = await storage.getPending(this.userId)
      const fresh = this.coordinator.snapshot().projection
      if (!this.current() || !fresh || needsReset(pending, fresh.streamId)) { this.notify(); return false }
      peerFinished = replacement === null
      acknowledgeSource = peerFinished || (replacement !== null && replacement.opId !== pending.opId)
      // A newer slot is never released or replayed here. Settle only an exact
      // unchanged source snapshot, and stop any dependent UI workflow.
    }
    if (acknowledgeSource && this.current()) for (const session of this.sessions) session.acknowledge(submittedDraft)
    this.notify()
    return (released || peerFinished) && this.current()
  }
  async resolveRejection() {
    this.assertDispatch()
    await this.coordinator.catchUp()
    const storage = await this.storage(), pending = await storage.getPending(this.userId)
    if (!pending || !['conflict', 'rejected'].includes(pending.status)) throw new Error('Эта отправка ещё не разрешена. Повторите проверку её состояния.')
    if (needsReset(pending, this.coordinator.snapshot().projection!.streamId)) { await this.reconcile(); throw new Error('Источник данных изменился. Сначала проверьте исходную отправку.') }
    await storage.transition(pending, null) // Input stays. Next explicit submit gets a new opId.
    this.notify()
  }
  async clearAccount() { const storage = await this.storage(); await storage.clearAccount(this.userId); this.notify() }
}

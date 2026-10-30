import { ApiError, IdentityChangedError, read } from '../api/client.ts'
import { identityState } from '../state/session.ts'
import type { BootstrapPage } from '../api/types.ts'
import { bootstrapPage, changesPage, SyncSchemaError } from './validation.ts'
import { emptyProjection, replaceItems, validateProjection, type Projection } from './projection.ts'

export interface SyncState { projection: Projection | null; status: 'loading' | 'ready' | 'stale' | 'stopped'; error: Error | null; busy: boolean }
type Reader = (path: string) => Promise<unknown>
export const DELTA_LIMITS = { pages: 100, changes: 5000, bytes: 16 * 1024 * 1024, milliseconds: 30_000 }
export class DeltaLimitError extends Error { constructor() { super('Обновление превысило безопасный размер или время ожидания. Показана последняя целиком подтверждённая редакция. Повторите обновление; ввод и отправка сохранены.') } }
// One serialized reader/publisher per tab/account. Cursor is never persisted.
export class SyncCoordinator {
  private state: SyncState = { projection: null, status: 'loading', error: null, busy: false }
  private listeners = new Set<() => void>()
  private serial: Promise<void> = Promise.resolve()
  private stopped = false
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private backoff = 1000
  private polling = false
  private current: () => boolean
  readonly userId: string
  private reader: Reader
  private limits: typeof DELTA_LIMITS
  private clock: () => number
  constructor(userId: string, reader: Reader = read, current?: () => boolean, options: { limits?: Partial<typeof DELTA_LIMITS>; clock?: () => number } = {}) {
    this.userId = userId; this.reader = reader
    this.limits = { ...DELTA_LIMITS, ...options.limits }; this.clock = options.clock ?? (() => performance.now())
    const epoch = identityState.epoch
    this.current = current ?? (() => identityState.userId === userId && identityState.epoch === epoch)
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: SyncState) { this.assertCurrent(); this.state = next; for (const listener of this.listeners) listener() }
  private assertCurrent() { if (this.stopped || !this.current()) throw new IdentityChangedError('Сеанс изменился. Синхронизация прежнего аккаунта остановлена.') }
  private async request(path: string) { this.assertCurrent(); const value = await this.reader(path); this.assertCurrent(); return value }
  private async bootstrap() {
    const generation = ++this.generation
    let first: BootstrapPage | undefined, staging: Projection | undefined, cursor: string | null = null
    const cursors = new Set<string>(), keys = new Set<string>()
    let lastKey = '', count = 0, bytes = 0
    do {
      const page = bootstrapPage(await this.request(`/sync/bootstrap?pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
      if (page.nextPageCursor && !page.items.length) throw new SyncSchemaError()
      if (!first) { first = page; staging = emptyProjection(page.planState, page.asOfCursor, page.streamId, generation) }
      if (page.streamId !== first.streamId || page.snapshotId !== first.snapshotId || page.expiresAt !== first.expiresAt || page.asOfCursor !== first.asOfCursor || page.planState.planningInputRevision !== first.planState.planningInputRevision || page.planState.scheduleVersion !== first.planState.scheduleVersion) throw new SyncSchemaError()
      for (const item of page.items) {
        const rank = { settings: 0, category: 1, definition: 2, occurrence: 3, recurrence: 4 }[item.kind]
        const key = `${rank}:${item.kind === 'settings' ? '' : item.value.id.toLowerCase()}`
        if (keys.has(key) || key < lastKey) throw new SyncSchemaError()
        keys.add(key); lastKey = key; count++; bytes += new TextEncoder().encode(JSON.stringify(item)).length
      }
      if (count > 5000 || bytes > 16 * 1024 * 1024) throw new SyncSchemaError()
      staging = replaceItems(staging!, page.items, first.planState, first.asOfCursor)
      cursor = page.nextPageCursor
      if (cursor) { if (cursors.has(cursor)) throw new SyncSchemaError(); cursors.add(cursor) }
    } while (cursor)
    validateProjection(staging!)
    this.publish({ projection: staging!, status: 'ready', error: null, busy: true })
  }
  private async pass() {
    let more = true, pages = 0, count = 0, bytes = 0
    const started = this.clock()
    let staging = this.state.projection!
    const cursors = new Set<string>(), changes = new Set<string>()
    while (more) {
      const remaining = this.limits.milliseconds - (this.clock() - started)
      if (remaining < 0 || pages >= this.limits.pages) throw new DeltaLimitError()
      let timer: ReturnType<typeof setTimeout> | undefined
      let raw: unknown
      try { raw = await Promise.race([this.request(`/sync/changes?cursor=${encodeURIComponent(staging.cursor)}&pageSize=50`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeltaLimitError()), Math.max(1, remaining)) })]) } finally { clearTimeout(timer) }
      if (this.clock() - started > this.limits.milliseconds) throw new DeltaLimitError()
      const page = changesPage(raw)
      if (page.streamId !== staging.streamId) throw new ApiError({ code: 'syncResetRequired', status: 410 } as never)
      if (page.hasMore && (page.nextCursor === staging.cursor || cursors.has(page.nextCursor) || !page.changes.length)) throw new SyncSchemaError()
      for (const change of page.changes) { if (changes.has(change.id)) throw new SyncSchemaError(); changes.add(change.id) }
      pages++; count += page.changes.length
      for (const change of page.changes) bytes += new TextEncoder().encode(JSON.stringify(change)).length
      if (count > this.limits.changes || bytes > this.limits.bytes) throw new DeltaLimitError()
      cursors.add(page.nextCursor)
      staging = replaceItems(staging, page.changes.map(change => change.item), page.changes.at(-1)?.planState ?? staging.planState, page.nextCursor)
      more = page.hasMore
    }
    validateProjection(staging)
    if (this.clock() - started > this.limits.milliseconds) throw new DeltaLimitError()
    this.publish({ projection: staging, status: 'ready', error: null, busy: true })
  }
  // Every call is queued. An ACK call therefore starts its own *new* tail after
  // any already-running bounded pass, even when that pass began before the ACK.
  catchUp = (): Promise<void> => {
    const run = async () => {
      this.assertCurrent()
      if (this.state.status === 'stopped') throw this.state.error ?? new SyncSchemaError()
      this.publish({ ...this.state, busy: true })
      try {
        try { if (!this.state.projection || this.state.status === 'loading') await this.bootstrap(); await this.pass() }
        catch (error) {
          if (error instanceof DeltaLimitError || (error instanceof ApiError && (error.problem.code === 'invalidCursor' || error.problem.status === 410))) {
            this.publish({ ...this.state, status: 'loading' }); await this.bootstrap(); await this.pass()
          } else throw error
        }
        this.backoff = 1000
        this.publish({ ...this.state, status: 'ready', error: null, busy: false })
      } catch (error) {
        if (!this.stopped && this.current()) {
          const fatal = error instanceof SyncSchemaError || error instanceof IdentityChangedError || (error instanceof ApiError && (error.problem.code === 'syncSnapshotTooLarge' || error.problem.status === 401))
          this.publish({ ...this.state, busy: false, status: fatal ? 'stopped' : 'stale', error: error instanceof Error ? error : new Error('Синхронизация недоступна.') })
        }
        throw error
      }
    }
    const result = this.serial.then(run)
    this.serial = result.catch(() => undefined)
    return result
  }
  private wake = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void this.poll() }
  private async poll() {
    if (this.polling || this.stopped || this.state.status === 'stopped') return
    clearTimeout(this.timer); this.polling = true
    try { await this.catchUp() } catch { this.backoff = Math.min(30000, this.backoff * 2) }
    finally {
      this.polling = false
      if (!this.stopped && this.snapshot().status !== 'stopped') this.timer = setTimeout(() => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { this.timer = setTimeout(this.wake, 5000); return }; void this.poll() }, this.state.error ? this.backoff * (0.8 + Math.random() * 0.4) : 5000)
    }
  }
  start() {
    if (typeof window !== 'undefined') { window.addEventListener('focus', this.wake); window.addEventListener('online', this.wake); document.addEventListener('visibilitychange', this.wake) }
    void this.poll()
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.timer); if (typeof window !== 'undefined') { window.removeEventListener('focus', this.wake); window.removeEventListener('online', this.wake); document.removeEventListener('visibilitychange', this.wake) } }
}

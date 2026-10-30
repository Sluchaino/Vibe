import type { DraftRecord, StoragePort } from '../persistence/database.ts'
import { openEditorDraft, sameData, sameDraftRevision } from './durable-draft.ts'

export class DraftConflictError extends Error {
  constructor() { super('Черновик изменён или удалён в другой вкладке. Ваш ввод сохранён в аварийном восстановлении. Откройте сохранённую редакцию для сравнения; переход приостановлен.') }
}
export class DraftSession {
  private record: DraftRecord
  private baseline: { value: unknown; base: unknown }
  private expected: number | null
  private persisted: boolean
  private settled = false
  private listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private bufferRevision = 0
  private saving: Promise<void> | undefined
  private restoredBuffer: { draftId: string; revision: number } | undefined
  readonly bufferId: string
  error: Error | null = null
  constructor(userId: string, key: string, value: unknown, base: unknown, restored: DraftRecord | null, privatePort: () => Promise<StoragePort>, notify: () => void, tabId: string) {
    this.port = privatePort; this.notify = notify
    this.record = openEditorDraft(userId, key, value, base, restored)
    this.expected = restored ? Object.hasOwn(restored, 'expectedRevision') ? restored.expectedRevision ?? null : restored.revision : null
    this.record = { ...this.record, expectedRevision: this.expected }
    if (restored?.category === 'emergency' && !restored.pendingOpId) this.restoredBuffer = { draftId: restored.draftId, revision: restored.revision }
    this.persisted = this.expected !== null
    this.baseline = structuredClone(restored?.category === 'emergency' ? restored.saved ?? { value, base } : { value: this.record.value, base: this.record.base })
    this.bufferId = `emergency:${tabId}:${this.record.draftId}:${crypto.randomUUID()}`
  }
  private port: () => Promise<StoragePort>
  private notify: () => void
  snapshot = () => this.record
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener(); this.notify() }
  get dirty() { return !sameData(this.record.value, this.baseline.value) || !sameData(this.record.base, this.baseline.base) }
  get needsLeave() { return this.dirty || (['new-task', 'new-definition', 'new-recurring-definition'].includes(this.record.key) && !this.persisted && !this.settled) }
  change(patch: Partial<Pick<DraftRecord, 'value' | 'base'>>) {
    this.record = { ...this.record, ...structuredClone(patch), editRevision: (this.record.editRevision ?? 0) + 1, updatedAt: Date.now() }
    this.emergency(); this.emit()
  }
  private emergency() {
    const buffer: DraftRecord = { ...structuredClone(this.record), category: 'emergency', sourceDraftId: this.record.draftId, draftId: this.bufferId, expectedRevision: this.expected, saved: structuredClone(this.baseline), revision: ++this.bufferRevision }
    this.writes = this.writes.catch(() => undefined).then(async () => { await (await this.port()).saveDraft(buffer) }).then(() => { if (!(this.error instanceof DraftConflictError)) this.error = null; this.notify() }).catch(error => { this.error = error instanceof Error ? error : new Error('Аварийное сохранение недоступно.'); this.emit() })
  }
  save(): Promise<void> {
    if (this.saving) return this.saving
    this.saving = this.saveCurrent().finally(() => { this.saving = undefined })
    return this.saving
  }
  private async saveCurrent() {
    if (this.persisted && !this.dirty) return
    const submitted = structuredClone(this.record), expected = this.expected
    const revision = expected === null ? 1 : expected + 1
    const stored = { ...submitted, category: 'manual' as const, revision, expectedRevision: revision, updatedAt: Date.now(), saved: undefined }
    const port = await this.port()
    if (!await port.saveDraftCas(stored, expected)) { this.error = new DraftConflictError(); this.emit(); throw this.error }
    this.expected = stored.revision; this.persisted = true; this.settled = true
    this.baseline = { value: submitted.value, base: submitted.base }
    this.record = { ...this.record, revision: stored.revision, expectedRevision: stored.revision }
    this.error = null
    if (!this.dirty) await this.clearEmergency(); else this.emergency()
    this.emit()
  }
  async discard() {
    const submitted = this.record
    await this.clearEmergency()
    if (!sameDraftRevision(this.record, submitted)) return
    this.record = { ...this.record, ...structuredClone(this.baseline), editRevision: (this.record.editRevision ?? 0) + 1 }
    this.settled = true; this.error = null; this.emit()
  }
  async clearEmergency() {
    const writes = this.writes, revision = this.bufferRevision, restored = this.restoredBuffer, bufferId = this.bufferId, userId = this.record.userId
    await writes
    if (!revision && !restored) return
    const port = await this.port()
    if (revision) await port.deleteDraftCas(userId, bufferId, revision)
    if (restored) { await port.deleteDraftCas(userId, restored.draftId, restored.revision); if (this.restoredBuffer === restored) this.restoredBuffer = undefined }
  }
  async retryEmergency() { if (this.dirty) this.emergency(); await this.writes; if (this.error) throw this.error }
  acknowledge(submitted: DraftRecord) {
    if (!sameDraftRevision(this.record, submitted)) return
    this.baseline = { value: structuredClone(this.record.value), base: structuredClone(this.record.base) }
    this.settled = true
    void this.clearEmergency().catch(() => undefined); this.emit()
  }
  finish(value: unknown, base: unknown) {
    this.record = { ...this.record, value: structuredClone(value), base: structuredClone(base), editRevision: (this.record.editRevision ?? 0) + 1 }
    this.baseline = { value: structuredClone(value), base: structuredClone(base) }; this.settled = true; void this.clearEmergency().catch(() => undefined); this.emit()
  }
}

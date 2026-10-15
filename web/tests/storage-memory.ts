// Transactional port double for state-machine tests. Native adapter is exercised
// separately by native-storage.html in a real browser, not claimed by these tests.
import { samePending, type DraftRecord, type PendingPatch, type PendingRecord, type StoragePort } from '../src/persistence/database.ts'
export class MemoryStorage implements StoragePort {
  saved = new Map<string, DraftRecord>()
  slots = new Map<string, PendingRecord>()
  failWrites = false
  private serial: Promise<unknown> = Promise.resolve()
  private tx<T>(action: () => T): Promise<T> { const run = this.serial.then(() => { if (this.failWrites) throw new Error('quota'); return action() }); this.serial = run.catch(() => undefined); return run }
  close() {}
  async drafts(userId: string) { return structuredClone([...this.saved.values()].filter(row => row.userId === userId)) }
  async getPending(userId: string) { return structuredClone(this.slots.get(userId) ?? null) }
  saveDraft(draft: DraftRecord) { return this.tx(() => { const key = draft.userId + draft.draftId; if (!this.saved.has(key) || this.saved.get(key)!.revision < draft.revision) this.saved.set(key, structuredClone(draft)) }) }
  reserve(pending: PendingRecord, draft: DraftRecord) { return this.tx(() => { if (this.slots.has(pending.userId)) return false; this.slots.set(pending.userId, structuredClone(pending)); const key = draft.userId + draft.draftId; if (!this.saved.has(key) || this.saved.get(key)!.revision <= draft.revision) this.saved.set(key, structuredClone(draft)); return true }) }
  transition(expected: PendingRecord, patch: PendingPatch | null, cleanDraft = false) { return this.tx(() => {
    const actual = this.slots.get(expected.userId)
    if (!samePending(actual, expected)) return false
    if (patch) this.slots.set(expected.userId, { ...actual!, ...structuredClone(patch), pendingRevision: expected.pendingRevision + 1 }); else this.slots.delete(expected.userId)
    const key = expected.userId + expected.draftId
    if (cleanDraft && this.saved.get(key)?.revision === expected.draftRevision) this.saved.delete(key)
    return true
  }) }
  clearAccount(userId: string) { return this.tx(() => { if (this.slots.has(userId)) throw new Error('pending'); for (const [key, value] of this.saved) if (value.userId === userId) this.saved.delete(key) }) }
}

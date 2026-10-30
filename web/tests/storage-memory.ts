// Transactional port double for state-machine tests. Native adapter is exercised
// separately by native-storage.html in a real browser, not claimed by these tests.
import { draftMatches, recoveryDraft, samePending, type DraftRecord, type PendingPatch, type PendingRecord, type StoragePort } from '../src/persistence/database.ts'
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
  saveDraftCas(draft: DraftRecord, expected: number | null) { return this.tx(() => { const key = draft.userId + draft.draftId; if (!draftMatches(this.saved.get(key), expected)) return false; this.saved.set(key, structuredClone(draft)); return true }) }
  deleteDraftCas(userId: string, draftId: string, revision: number) { return this.tx(() => { const key = userId + draftId; if (this.saved.get(key)?.revision !== revision) return false; this.saved.delete(key); return true }) }
  reserve(pending: PendingRecord, draft: DraftRecord) { return this.tx(() => { if (this.slots.has(pending.userId)) return false; this.slots.set(pending.userId, structuredClone(pending)); if (pending.recoveryDraftId) this.saved.set(pending.userId + pending.recoveryDraftId, recoveryDraft(pending, draft)); return true }) }
  transition(expected: PendingRecord, patch: PendingPatch | null, cleanDraft = false) { return this.tx(() => {
    const actual = this.slots.get(expected.userId)
    if (!samePending(actual, expected)) return false
    if (patch) this.slots.set(expected.userId, { ...actual!, ...structuredClone(patch), pendingRevision: expected.pendingRevision + 1 }); else this.slots.delete(expected.userId)
    const key = expected.userId + expected.recoveryDraftId
    const row = this.saved.get(key)
    if (cleanDraft && expected.recoveryDraftId && row?.category === 'emergency' && row.pendingOpId === expected.opId && row.revision === expected.recoveryRevision) this.saved.delete(key)
    return true
  }) }
  clearAccount(userId: string) { return this.tx(() => { if (this.slots.has(userId)) throw new Error('pending'); for (const [key, value] of this.saved) if (value.userId === userId) this.saved.delete(key) }) }
}

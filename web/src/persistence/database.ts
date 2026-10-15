import type { PendingCommand } from '../lib/operations.ts'
import type { ProblemDetails } from '../api/types.ts'

export interface DraftRecord { userId: string; draftId: string; key: string; value: unknown; base: unknown; revision: number; updatedAt: number }
export type PendingStatus = 'unconfirmed' | 'acknowledgedRefresh' | 'conflict' | 'rejected' | 'resetReview'
export interface PendingRecord {
  userId: string; opId: string; command: PendingCommand; query: string; ifMatch: string | null
  draftId: string; draftRevision: number; streamId: string; status: PendingStatus; pendingRevision: number
  submittedDraft: DraftRecord
  problem?: ProblemDetails; previousStatus?: PendingStatus; authorizedStream?: string
}
export type PendingPatch = Partial<Pick<PendingRecord, 'status' | 'problem' | 'previousStatus' | 'authorizedStream'>>
export interface StoragePort {
  drafts(userId: string): Promise<DraftRecord[]>
  saveDraft(draft: DraftRecord): Promise<void>
  getPending(userId: string): Promise<PendingRecord | null>
  reserve(pending: PendingRecord, draft: DraftRecord): Promise<boolean>
  transition(expected: PendingRecord, patch: PendingPatch | null, cleanDraft?: boolean): Promise<boolean>
  clearAccount(userId: string): Promise<void>
  close(): void
}
export class StorageError extends Error {}
export function samePending(actual: PendingRecord | undefined, expected: PendingRecord) {
  return !!actual && actual.userId === expected.userId && actual.opId === expected.opId && actual.pendingRevision === expected.pendingRevision && actual.status === expected.status
}
// Factory injection is used by the native browser harness with isolated databases.
// No application data is deleted on blocked upgrade, quota, or unsupported version.
export function openStorage(databaseName = 'Vibe.S1', factory?: IDBFactory): Promise<StoragePort> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      const available = factory ?? globalThis.indexedDB
      if (!available || typeof available.open !== 'function') throw new Error('unavailable')
      request = available.open(databaseName, 1)
    } catch {
      reject(new StorageError('Локальное сохранение недоступно в этом браузере. Просмотр данных доступен, новая отправка остановлена.'))
      return
    }
    let blocked = false
    request.onblocked = () => { blocked = true; reject(new StorageError('Хранилище занято другой вкладкой. Закройте старую версию приложения и повторите.')) }
    request.onerror = () => reject(new StorageError(`Локальное сохранение недоступно: ${request.error?.name ?? 'ошибка браузера'}. Новая отправка остановлена.`))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: ['userId', 'draftId'] })
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'userId' })
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) { db.close(); return }
      db.onversionchange = () => db.close()
      function transaction<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
        return new Promise((ok, fail) => {
          let value: T
          let tx: IDBTransaction
          try { tx = db.transaction(names, mode); work(tx, result => { value = result }) } catch { fail(new StorageError('Локальное сохранение недоступно. Новая отправка остановлена.')); return }
          tx.oncomplete = () => ok(value)
          tx.onabort = tx.onerror = () => fail(new StorageError(`Не удалось сохранить в этом браузере: ${tx.error?.name ?? 'transaction aborted'}. Отправка не начата.`))
        })
      }
      const get = <T>(req: IDBRequest<T>, callback: (value: T) => void) => { req.onsuccess = () => callback(req.result) }
      const store: StoragePort = {
        close: () => db.close(),
        drafts: userId => transaction(['drafts'], 'readonly', (tx, done) => { get(tx.objectStore('drafts').getAll(), records => done((records as DraftRecord[]).filter(row => row.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt))) }),
        getPending: userId => transaction(['pending'], 'readonly', (tx, done) => get(tx.objectStore('pending').get(userId), value => done(value ?? null))),
        saveDraft: draft => transaction(['drafts'], 'readwrite', (tx, done) => {
          const drafts = tx.objectStore('drafts')
          get(drafts.get([draft.userId, draft.draftId]), (old: DraftRecord | undefined) => { if (!old || old.revision < draft.revision) drafts.put(structuredClone(draft)); done(undefined) })
        }),
        reserve: (pending, draft) => transaction(['pending', 'drafts'], 'readwrite', (tx, done) => {
          const slots = tx.objectStore('pending'), drafts = tx.objectStore('drafts')
          get(slots.get(pending.userId), old => {
            if (old) { done(false); return }
            slots.add(structuredClone(pending))
            get(drafts.get([draft.userId, draft.draftId]), (saved: DraftRecord | undefined) => { if (!saved || saved.revision <= draft.revision) drafts.put(structuredClone(draft)); done(true) })
          })
        }),
        transition: (expected, patch, cleanDraft = false) => transaction(['pending', 'drafts'], 'readwrite', (tx, done) => {
          const slots = tx.objectStore('pending'), drafts = tx.objectStore('drafts')
          get(slots.get(expected.userId), (actual: PendingRecord | undefined) => {
            if (!samePending(actual, expected)) { done(false); return }
            if (patch) slots.put({ ...actual, ...structuredClone(patch), pendingRevision: expected.pendingRevision + 1 })
            else slots.delete(expected.userId)
            if (cleanDraft) get(drafts.get([expected.userId, expected.draftId]), (draft: DraftRecord | undefined) => { if (draft?.revision === expected.draftRevision) drafts.delete([expected.userId, expected.draftId]) })
            done(true)
          })
        }),
        clearAccount: userId => transaction(['pending', 'drafts'], 'readwrite', (tx, done) => {
          get(tx.objectStore('pending').get(userId), pending => {
            if (pending) { tx.abort(); return }
            const drafts = tx.objectStore('drafts')
            get(drafts.getAll(), (records: DraftRecord[]) => { for (const row of records) if (row.userId === userId) drafts.delete([userId, row.draftId]); done(undefined) })
          })
        }),
      }
      resolve(store)
    }
  })
}

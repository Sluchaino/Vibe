import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountRuntime, freezePending, needsReset, uncertainFailure } from '../src/sync/runtime.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { ApiError, IdentityChangedError, NetworkError } from '../src/api/client.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { identityState } from '../src/state/session.ts'
import type { DraftRecord, PendingRecord } from '../src/persistence/database.ts'
import { MemoryStorage } from './storage-memory.ts'
import { bootstrap, deferred, delta, stream } from './sync-fixture.ts'
import { finishDraft, sameDraftRevision } from '../src/lib/durable-draft.ts'

const id1 = '20000000-0000-4000-8000-000000000001'
const id2 = '20000000-0000-4000-8000-000000000002'
function draft(revision = 1): DraftRecord { return { userId: 'anna', draftId: id1, key: 'settings', value: { name: revision === 1 ? 'Первый ввод' : 'Продолженный ввод' }, base: { serverVersion: 'v1' }, revision, updatedAt: 1 } }
function pending(): PendingRecord { return freezePending(captureCommand('anna', { method: 'PUT', path: '/settings', version: 'v1', body: { timezone: 'UTC' } }, id1), draft(), stream) }
function error(status: number) { return new ApiError({ code: 'test', status, detail: 'test' } as never) }
async function runtime(storage: MemoryStorage, sender: ConstructorParameters<typeof AccountRuntime>[3], failRead?: () => boolean) {
  identityState.activate('anna')
  let initial = true
  const coordinator = new SyncCoordinator('anna', async () => { if (failRead?.()) throw new NetworkError('read failure'); if (initial) { initial = false; return bootstrap() }; return delta() })
  await coordinator.catchUp()
  const account = new AccountRuntime('anna', Promise.resolve(storage), coordinator, sender)
  account.editors.set('settings', () => draft())
  await account.reload()
  return account
}
test('two concurrent reservations have one winner, and old ACK/error cannot clear a new slot or later draft revision', async () => {
  const storage = new MemoryStorage(), first = pending(), second = { ...pending(), opId: id2, command: { ...pending().command, opId: id2 } }
  assert.deepEqual(await Promise.all([storage.reserve(first, draft()), storage.reserve(second, draft())]), [true, false])
  await storage.saveDraft(draft(2))
  assert.deepEqual((await storage.getPending('anna'))?.submittedDraft.value, { name: 'Первый ввод' })
  assert.equal((await storage.getPending('anna'))?.submittedDraft.revision, 1)
  assert.equal(await storage.transition(first, { status: 'acknowledgedRefresh' }), true)
  assert.equal(await storage.transition(first, { status: 'rejected' }), false)
  const ack = (await storage.getPending('anna'))!
  assert.equal(await storage.transition(ack, null, true), true)
  assert.equal((await storage.drafts('anna'))[0]?.revision, 2)
  assert.equal(await storage.reserve(second, draft(2)), true)
  assert.equal(await storage.transition(ack, null, true), false)
  assert.equal((await storage.getPending('anna'))?.opId, id2)
  assert.equal((await storage.drafts('anna'))[0]?.value && (await storage.drafts('anna'))[0]?.revision, 2)
})
test('commit-before-fetch and synchronous submit guard reserve exactly one frozen command', async () => {
  const storage = new MemoryStorage(), sent = deferred<unknown>(), entered = deferred<void>()
  let sends = 0
  const account = await runtime(storage, async (command, guard) => {
    guard(); sends++
    const stored = await storage.getPending('anna')
    assert.equal(stored?.opId, command.opId)
    assert.equal((await storage.drafts('anna'))[0]?.revision, 1)
    entered.resolve(); return sent.promise
  })
  const first = account.submit('settings', { method: 'PUT', path: '/settings', version: 'v1', body: { timezone: 'UTC' } })
  await entered.promise
  await assert.rejects(account.submit('settings', { method: 'PUT', path: '/settings', body: {} }), /дождитесь/)
  sent.resolve({ data: { obsoleteMutationBody: true }, replayed: true })
  assert.equal((await first).success, true)
  assert.equal(sends, 1); assert.equal(await storage.getPending('anna'), null)
  assert.equal(account.coordinator.snapshot().projection?.settings?.timezone, 'Europe/Berlin') // ACK was never merged.
  account.stop()
})
test('quota/failed commit prevents the first network send and retains input in memory', async () => {
  const storage = new MemoryStorage(); let sends = 0
  const account = await runtime(storage, async () => { sends++ })
  storage.failWrites = true
  await assert.rejects(account.submit('settings', { method: 'PUT', path: '/settings', body: {} }), /quota/)
  assert.equal(sends, 0)
  assert.equal(account.editors.get('settings')?.().revision, 1)
  account.stop()
})
test('lost ACK then 403/408/429 keep original opId and block replacement by a new operation', async () => {
  const storage = new MemoryStorage(); const sent: string[] = []; let attempt = 0
  const account = await runtime(storage, async command => { sent.push(command.opId); attempt++; if (attempt === 1) throw new NetworkError('lost ACK'); throw error(attempt === 2 ? 403 : attempt === 3 ? 408 : 429) })
  await assert.rejects(account.submit('settings', { method: 'PUT', path: '/settings', version: 'v1', body: {} }))
  for (let i = 0; i < 3; i++) await assert.rejects(account.retry())
  const original = (await storage.getPending('anna'))!
  assert.equal(original.status, 'unconfirmed'); assert.equal(new Set(sent).size, 1)
  await assert.rejects(account.resolveRejection(), /ещё не разрешена/)
  await assert.rejects(account.submit('settings', { method: 'PUT', path: '/settings', body: { changed: true } }), /другая отправка/)
  assert.equal((await storage.getPending('anna'))?.opId, original.opId)
  for (const status of [400, 404, 409, 412, 428]) assert.equal(uncertainFailure(error(status)), false)
  for (const status of [401, 403, 408, 429, 500, 503]) assert.equal(uncertainFailure(error(status)), true)
  account.stop()
})
test('identity changes after dispatch retain original account pending and never deliver to a new account', async () => {
  const storage = new MemoryStorage(), sent = deferred<unknown>(), entered = deferred<void>()
  const account = await runtime(storage, async (_command, guard) => { guard(); entered.resolve(); return sent.promise })
  const action = account.submit('settings', { method: 'PUT', path: '/settings', body: {} })
  await entered.promise; identityState.activate('boris'); sent.reject(new IdentityChangedError('changed'))
  await assert.rejects(action, IdentityChangedError)
  assert.equal((await storage.getPending('anna'))?.status, 'unconfirmed')
  assert.equal(await storage.getPending('boris'), null)
  await assert.rejects(account.retry(), IdentityChangedError)
  account.stop()
})
test('ACK refresh failure retains acknowledgedRefresh, recovery reads only and preserves newer draft revision', async () => {
  const storage = new MemoryStorage(); let failing = false, sends = 0
  const account = await runtime(storage, async () => { sends++; await storage.saveDraft(draft(2)); failing = true; return {} }, () => failing)
  await assert.rejects(account.submit('settings', { method: 'PUT', path: '/settings', body: {} }), /read failure/)
  assert.equal((await storage.getPending('anna'))?.status, 'acknowledgedRefresh')
  failing = false; await account.coordinator.catchUp(); await account.retry()
  assert.equal(sends, 1); assert.equal(await storage.getPending('anna'), null)
  assert.equal((await storage.drafts('anna'))[0]?.revision, 2)
  account.stop()
})
test('stream reset requires review for every unfinished status, including known ACK and final rejection', async () => {
  const next = '10000000-0000-4000-8000-000000000099'
  for (const status of ['unconfirmed', 'acknowledgedRefresh', 'conflict', 'rejected'] as const) {
    const original = { ...pending(), status }
    assert.equal(needsReset(original, next), true)
    assert.equal(needsReset(original, stream), false)
    assert.equal(needsReset({ ...original, authorizedStream: next }, next), false)
  }
})
test('failed initial storage open can reopen safely, without deleting existing drafts', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(); await storage.saveDraft(draft())
  let opens = 0
  const account = new AccountRuntime('anna', Promise.reject(new Error('open blocked')), undefined, undefined, async () => { opens++; return storage })
  await account.reload(); assert.match(account.snapshot().storageError?.message ?? '', /open blocked/)
  await account.retryStorage()
  assert.equal(opens, 1); assert.equal(account.snapshot().ready, true); assert.equal(account.snapshot().drafts.length, 1)
  account.stop()
})
test('own completed settings editor uses fresh base for next save; input changed before ACK keeps old base', async () => {
  const storage = new MemoryStorage(); const versions: (string | undefined)[] = []
  const account = await runtime(storage, async command => { versions.push(command.version) })
  let current = draft()
  account.editors.set('settings', () => current)
  const submitted = structuredClone(current)
  const first = await account.submit('settings', { method: 'PUT', path: '/settings', version: 'v1', body: { name: 'Первый ввод' } })
  assert.equal(first.success, true)
  current = finishDraft(current, submitted, { name: 'Подтверждённый ввод' }, { serverVersion: 'v2' })
  current = { ...current, value: { name: 'Следующее редактирование' }, revision: current.revision + 1 }
  await account.submit('settings', { method: 'PUT', path: '/settings', version: (current.base as { serverVersion: string }).serverVersion, body: { name: 'Следующее редактирование' } })
  assert.deepEqual(versions, ['v1', 'v2'])
  const editedBeforeAck = { ...submitted, value: { name: 'Ещё новый ввод' }, revision: submitted.revision + 1 }
  assert.equal(sameDraftRevision(editedBeforeAck, submitted), false)
  assert.deepEqual(finishDraft(editedBeforeAck, submitted, { name: 'Старый подтверждённый ввод' }, { serverVersion: 'v3' }), editedBeforeAck)
  assert.deepEqual(editedBeforeAck.base, { serverVersion: 'v1' })
  account.stop()
})
test('stream reset transitions every unfinished persisted state to review and explicit replay preserves frozen target', async () => {
  const newStream = '10000000-0000-4000-8000-000000000099'
  for (const status of ['unconfirmed', 'acknowledgedRefresh', 'conflict', 'rejected'] as const) {
    identityState.activate('anna')
    const storage = new MemoryStorage()
    const original = { ...pending(), status }
    original.command.path = '/occurrences/80000000-0000-4000-8000-000000000001/completion/reopen'
    original.command.body = { opId: original.opId, completionId: id2 }
    await storage.reserve(original, draft())
    let initial = true, reset = false, newBootstrap = false, sends = 0
    const coordinator = new SyncCoordinator('anna', async path => {
      if (initial) { initial = false; return bootstrap() }
      if (reset && !newBootstrap && path.startsWith('/sync/changes')) throw new ApiError({ status: 410, code: 'syncResetRequired' } as never)
      if (path.startsWith('/sync/bootstrap')) { newBootstrap = true; return bootstrap({ streamId: newStream }) }
      return delta({ streamId: newBootstrap ? newStream : stream })
    })
    await coordinator.catchUp()
    const account = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => { sends++; assert.deepEqual(command, original.command) })
    await account.reload(); reset = true; await coordinator.catchUp(); await account.reconcile()
    const review = (await storage.getPending('anna'))!
    assert.equal(review.status, 'resetReview'); assert.equal(review.previousStatus, status); assert.equal(sends, 0)
    await assert.rejects(account.resolveRejection(), /ещё не разрешена/)
    assert.equal(await account.retry(true), true)
    assert.equal(sends, 1); assert.equal(await storage.getPending('anna'), null)
    account.stop()
  }
})
test('stop during delayed storage opening prevents start from creating a late interval', async context => {
  identityState.activate('anna')
  const storage = deferred<MemoryStorage>()
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
  const account = new AccountRuntime('anna', storage.promise, coordinator)
  const scheduled = context.mock.method(globalThis, 'setInterval')
  const starting = account.start()
  account.stop()
  storage.resolve(new MemoryStorage())
  await starting
  assert.equal(scheduled.mock.calls.length, 0)
  assert.equal(account.current(), false)
})
test('unavailable or throwing IndexedDB API keeps coordinator/view usable and prevents sending', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  try {
    for (const throwing of [false, true]) {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get: () => { if (throwing) throw new DOMException('Storage denied', 'SecurityError'); return undefined } })
      identityState.activate('anna')
      const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
      let sends = 0
      const account = new AccountRuntime('anna', undefined, coordinator, async () => { sends++ })
      await coordinator.catchUp(); await account.reload()
      assert.equal(coordinator.snapshot().status, 'ready')
      assert.equal(coordinator.snapshot().projection?.definitions.size, 1)
      assert.match(account.snapshot().storageError?.message ?? '', /Локальное сохранение недоступно/)
      await assert.rejects(account.submit('settings', { method: 'PUT', path: '/settings', body: {} }))
      assert.equal(sends, 0)
      account.stop()
    }
  } finally { if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else Reflect.deleteProperty(globalThis, 'indexedDB') }
})

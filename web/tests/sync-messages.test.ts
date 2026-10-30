import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/api/client.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { AccountRuntime } from '../src/sync/runtime.ts'
import { bootstrapBusyMessage } from '../src/lib/sync-messages.ts'
import { identityState } from '../src/state/session.ts'
import { MemoryStorage } from './storage-memory.ts'

test('real initial Coordinator 429/503 syncBootstrapBusy maps to a later-refresh message and preserves account drafts', async () => {
  for (const status of [429, 503]) {
    identityState.activate('anna')
    const storage = new MemoryStorage()
    const saved = { userId: 'anna', draftId: 'saved', key: 'new-definition', value: { title: 'Сохранённый ввод' }, base: null, revision: 1, updatedAt: 1 }
    await storage.saveDraft(saved)
    const problem = { status, code: 'syncBootstrapBusy', detail: 'Запрос не может быть выполнен. Проверьте данные и текущую версию ресурса.' } as never
    let requests = 0
    const coordinator = new SyncCoordinator('anna', async () => { requests++; throw new ApiError(problem) })
    const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator)
    await runtime.reload()
    await assert.rejects(coordinator.catchUp(), ApiError)
    const error = coordinator.snapshot().error
    assert.ok(error instanceof ApiError); assert.equal(error.problem.status, status)
    const message = bootstrapBusyMessage(error.problem)
    assert.match(message!, /Сервер занят подготовкой начальной загрузки/)
    assert.match(message!, /позже.*«Обновить»/); assert.match(message!, /Данные и черновики сохранены/)
    assert.doesNotMatch(message!, /Проверьте данные|неверны/i)
    assert.equal(requests, 1, 'copy mapping must not alter retry/fallback bounds')
    assert.equal(coordinator.snapshot().status, 'stale'); assert.equal(coordinator.snapshot().projection, null)
    assert.deepEqual(await storage.drafts('anna'), [saved]); runtime.stop()
  }
})
test('bootstrap busy copy does not replace unrelated API problems or unsupported statuses', () => {
  assert.equal(bootstrapBusyMessage({ code: 'validationFailed', status: 400 }), null)
  assert.equal(bootstrapBusyMessage({ code: 'syncSnapshotTooLarge', status: 409 }), null)
  assert.equal(bootstrapBusyMessage({ code: 'syncBootstrapBusy', status: 400 }), null)
})

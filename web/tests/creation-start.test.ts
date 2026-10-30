import test from 'node:test'
import assert from 'node:assert/strict'
import { creationStartContinuation, creationStartEditorState, prepareCreation, type CreationStart } from '../src/lib/creation.ts'
import { sameData } from '../src/lib/durable-draft.ts'
import { AccountRuntime, freezePending } from '../src/sync/runtime.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { identityState } from '../src/state/session.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { emptyProjection, replaceItems } from '../src/sync/projection.ts'
import type { DraftRecord } from '../src/persistence/database.ts'
import { MemoryStorage } from './storage-memory.ts'
import { bootstrap, delta, items, plan, stream } from './sync-fixture.ts'

const definitionId = '70000000-0000-4000-8000-000000000001'
const start: CreationStart = { localStart: '2026-10-20T14:00', timezone: 'Europe/Moscow', utcOffset: '+03:00' }
const projection = () => replaceItems(emptyProjection(plan, 'cursor', stream, 1), items(), plan, 'cursor')
function setup() {
  const original = prepareCreation('anna', definitionId, '2026-10-20', undefined, start)
  const current = prepareCreation('anna', definitionId, '2026-10-21', original, { ...start, localStart: '2026-10-21T16:00' })
  const draft: DraftRecord = { userId: 'anna', draftId: crypto.randomUUID(), key: `creation-start:${definitionId}`, category: 'manual', value: { ...start, localStart: '2026-10-22T18:30' }, base: structuredClone(original.value), revision: 3, updatedAt: 1 }
  return { original, current, draft }
}
test('manual and emergency start drafts resolve their existing continuation and preserve selected input/original base against the latest intent', async () => {
  for (const emergency of [false, true]) {
    identityState.activate('anna')
    const { original, current, draft } = setup(), storage = new MemoryStorage()
    await storage.saveDraft(original); await storage.saveDraftCas(current, original.revision); await storage.saveDraft(draft)
    const selected = emergency ? { ...draft, draftId: 'buffer-id', category: 'emergency' as const, sourceDraftId: draft.draftId, expectedRevision: draft.revision, saved: { value: start, base: original.value } } : draft
    if (emergency) await storage.saveDraft(selected)
    const before = await storage.drafts('anna'), record = creationStartContinuation('anna', selected, before, projection())!
    assert.equal(record.draftId, original.draftId); assert.equal(record.revision, current.revision)
    assert.deepEqual(record.value.start, current.value.start)
    const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
    const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator)
    const editor = runtime.createSession(draft.key, record.value.start, record.value, selected)
    assert.deepEqual(editor.snapshot().value, draft.value); assert.deepEqual(editor.snapshot().base, original.value)
    assert.equal(editor.snapshot().draftId, draft.draftId)
    assert.equal(sameData(editor.snapshot().base, record.value), false, 'restoration must retain the old base for explicit comparison')
    assert.deepEqual(await storage.drafts('anna'), before, 'opening the start editor must not write or clone a draft')
    editor.change({ base: record.value }) // The explicit comparison action preserves input.
    assert.deepEqual(editor.snapshot().value, draft.value); assert.deepEqual(editor.snapshot().base, current.value)
    const chosen = editor.snapshot().value as CreationStart
    await runtime.saveDraftAndWait(prepareCreation('anna', definitionId, chosen.localStart.slice(0, 10), record, chosen))
    assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === original.draftId)?.value, { ...current.value, logicalDate: '2026-10-22', start: chosen })
    assert.equal(await storage.getPending('anna'), null, 'restore/rebase is not an automatic server command')
    runtime.stop()
  }
})
test('start restoration rejects foreign owner, missing confirmed definition/continuation, and a mismatched workflow without resurrecting anything', () => {
  const { current, draft } = setup(), state = projection()
  assert.equal(creationStartContinuation('boris', draft, [current], state), undefined)
  assert.equal(creationStartContinuation('anna', { ...draft, userId: 'boris' }, [current], state), undefined)
  assert.equal(creationStartContinuation('anna', draft, [{ ...current, userId: 'boris' }], state), undefined)
  assert.equal(creationStartContinuation('anna', draft, [], state), undefined)
  assert.equal(creationStartContinuation('anna', draft, [current], { ...state, definitions: new Map() }), undefined)
  assert.equal(creationStartContinuation('anna', draft, [{ ...current, value: { ...current.value, occurrenceId: crypto.randomUUID() } }], state), undefined)
  assert.equal(creationStartContinuation('anna', { ...draft, base: null }, [current], state), undefined)
  assert.equal(creationStartContinuation('anna', { ...draft, key: 'creation-start:unrelated' }, [current], state), undefined)
  assert.deepEqual(current.value.start, { ...start, localStart: '2026-10-21T16:00' })
})
test('another tab pending blocks a dirty start editor without changing its visibility/key/session/input for both legacy and explicitly reopened starts', async () => {
  for (const legacy of [false, true]) {
    identityState.activate('anna')
    const { current, draft } = setup(), record = legacy ? { ...current, value: { ...current.value, start: null } } : current
    const storage = new MemoryStorage(), coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
    const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator)
    const editor = runtime.createSession(draft.key, record.value.start ?? { localStart: '', timezone: 'Europe/Moscow', utcOffset: '' }, record.value, null)
    runtime.sessions.add(editor); editor.change({ value: draft.value }); await editor.retryEmergency(); await runtime.reload()
    const initial = creationStartEditorState(record, !legacy, !!runtime.snapshot().pending)
    const before = structuredClone(editor.snapshot())
    const other = freezePending(captureCommand('anna', { method: 'POST', path: '/categories', body: { name: 'Другая вкладка' } }), { ...draft, key: 'new-category', draftId: crypto.randomUUID() }, stream)
    await storage.reserve(other, other.submittedDraft); await runtime.reload()
    const blocked = creationStartEditorState(record, !legacy, !!runtime.snapshot().pending)
    assert.equal(initial.visible, true); assert.equal(blocked.visible, true)
    assert.equal(blocked.key, initial.key); assert.equal(blocked.disabled, true)
    assert.equal(runtime.sessions.has(editor), true); assert.equal(editor.dirty, true)
    assert.deepEqual(editor.snapshot(), before)
    await storage.transition(other, null); await runtime.reload()
    const resumed = creationStartEditorState(record, !legacy, !!runtime.snapshot().pending)
    assert.deepEqual(resumed, initial); assert.deepEqual(editor.snapshot(), before)
    const readOnly = creationStartEditorState(record, !legacy, false, true)
    assert.equal(readOnly.visible, true); assert.equal(readOnly.disabled, true); assert.equal(readOnly.key, initial.key)
    runtime.stop()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftConflictError, DraftSession } from '../src/lib/draft-session.ts'
import { AccountRuntime, freezePending } from '../src/sync/runtime.ts'
import { identityState } from '../src/state/session.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { draftCategory, type DraftRecord } from '../src/persistence/database.ts'
import { MemoryStorage } from './storage-memory.ts'
import { deferred, stream } from './sync-fixture.ts'

function manual(revision = 1): DraftRecord { return { userId: 'anna', draftId: 'saved-task', category: 'manual', key: 'new-definition', value: { title: 'Сохранено' }, base: { serverVersion: 'v1' }, revision, updatedAt: 1 } }
function session(storage: MemoryStorage, restored: DraftRecord | null = null, key = restored?.key ?? 'new-definition') { return new DraftSession('anna', key, { title: '' }, { serverVersion: 'v1' }, restored, async () => storage, () => undefined, 'tab-a') }
async function account(storage: MemoryStorage, restored: DraftRecord | null = null) {
  identityState.activate('anna')
  const runtime = new AccountRuntime('anna', Promise.resolve(storage))
  const editor = runtime.createSession(restored?.key ?? 'new-definition', { title: '' }, null, restored)
  runtime.sessions.add(editor)
  await runtime.reload()
  return { runtime, editor }
}

test('opening/closing an unchanged saved draft writes nothing, keeps stable ID, and explicit unchanged save is a no-op', async () => {
  const storage = new MemoryStorage(), saved = manual()
  await storage.saveDraft(saved)
  const first = session(storage, saved)
  assert.equal(first.dirty, false); assert.equal(first.needsLeave, false)
  await first.save(); await first.discard()
  const second = session(storage, (await storage.drafts('anna'))[0]!)
  assert.equal(second.snapshot().draftId, saved.draftId)
  assert.deepEqual(await storage.drafts('anna'), [saved])
})
test('a pristine new task asks before leaving but creates no user draft until explicit save', async () => {
  const storage = new MemoryStorage(), editor = session(storage)
  assert.equal(editor.dirty, false); assert.equal(editor.needsLeave, true)
  assert.deepEqual(await storage.drafts('anna'), [])
  await editor.save()
  const rows = await storage.drafts('anna')
  assert.equal(rows.length, 1); assert.equal(rows[0]?.draftId, editor.snapshot().draftId)
  assert.equal(draftCategory(rows[0]!), 'manual'); assert.equal(editor.needsLeave, false)
})
test('pristine One-off/Recurring switches do not ask or write; Close still asks, and dirty mode switches retain the three-way leave guard', async () => {
  for (const key of ['new-definition', 'new-recurring-definition']) {
    identityState.activate('anna')
    const storage = new MemoryStorage(), runtime = new AccountRuntime('anna', Promise.resolve(storage))
    const editor = runtime.createSession(key, { title: '' }, null, null)
    runtime.sessions.add(editor); await runtime.reload()
    let switched = 0
    assert.equal(await runtime.requestCreationModeChange(() => { switched++ }), true)
    assert.equal(switched, 1); assert.equal(runtime.snapshot().leaveRequested, false)
    assert.deepEqual(await storage.drafts('anna'), [])
    const closing = runtime.requestLeave(() => { throw new Error('pristine Close must wait for a choice') })
    assert.equal(runtime.snapshot().leaveRequested, true)
    await runtime.decideLeave('continue'); assert.equal(await closing, false)
    editor.change({ value: { title: 'Не потерять при смене типа' } })
    const canceled = runtime.requestCreationModeChange(() => { switched++ })
    assert.equal(runtime.snapshot().leaveRequested, true); assert.equal(switched, 1)
    await runtime.decideLeave('continue'); assert.equal(await canceled, false)
    assert.deepEqual(editor.snapshot().value, { title: 'Не потерять при смене типа' })
    const saved = runtime.requestCreationModeChange(() => { switched++ })
    await runtime.decideLeave('save'); assert.equal(await saved, true); assert.equal(switched, 2)
    const manual = (await storage.drafts('anna')).filter(row => row.category === 'manual')
    assert.equal(manual.length, 1); assert.equal(manual[0]?.draftId, editor.snapshot().draftId)
    assert.deepEqual(manual[0]?.value, { title: 'Не потерять при смене типа' })
    runtime.stop()
  }
})
test('pristine creation-mode switch still guards a dirty sibling editor and cannot navigate a closed account', async () => {
  const storage = new MemoryStorage(), { runtime } = await account(storage)
  const sibling = runtime.createSession('settings', { name: 'Дом' }, null, null)
  runtime.sessions.add(sibling); sibling.change({ value: { name: 'Изменённое место' } })
  let moved = false
  const switching = runtime.requestCreationModeChange(() => { moved = true })
  assert.equal(runtime.snapshot().leaveRequested, true); assert.equal(moved, false)
  await runtime.decideLeave('continue'); assert.equal(await switching, false)
  runtime.stop(); assert.equal(await runtime.requestCreationModeChange(() => { moved = true }), false)
  assert.equal(moved, false)
})
test('editing writes a separate emergency buffer, while explicit save updates one manual ID and preserves its server base', async () => {
  const storage = new MemoryStorage(), saved = manual()
  await storage.saveDraft(saved)
  const editor = session(storage, saved)
  editor.change({ value: { title: 'Изменено' } }); await editor.retryEmergency()
  let rows = await storage.drafts('anna')
  assert.deepEqual(rows.find(row => row.draftId === saved.draftId)?.value, saved.value)
  assert.equal(rows.filter(row => draftCategory(row) === 'manual').length, 1)
  assert.deepEqual(rows.find(row => row.category === 'emergency')?.value, { title: 'Изменено' })
  await editor.save()
  rows = await storage.drafts('anna')
  assert.equal(rows.length, 1); assert.equal(rows[0]?.draftId, saved.draftId); assert.equal(rows[0]?.revision, 2)
  assert.deepEqual(rows[0]?.base, saved.base); assert.equal(editor.dirty, false)
  editor.change({ value: { title: 'Ещё изменение' } }); await editor.save()
  assert.equal((await storage.drafts('anna')).filter(row => row.category === 'manual').length, 1)
  assert.equal((await storage.drafts('anna')).find(row => row.draftId === saved.draftId)?.revision, 3)
})
test('two tab editors compete through CAS; the losing editor keeps its input and cannot resurrect another-tab deletion', async () => {
  const storage = new MemoryStorage(), saved = manual()
  await storage.saveDraft(saved)
  const a = session(storage, saved), b = session(storage, saved)
  a.change({ value: { title: 'A' } }); b.change({ value: { title: 'B' } })
  const outcomes = await Promise.allSettled([a.save(), b.save()])
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected'])
  assert.ok(b.error instanceof DraftConflictError); assert.deepEqual(b.snapshot().value, { title: 'B' }); assert.equal(b.dirty, true)
  assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === saved.draftId)?.value, { title: 'A' })
  assert.equal(await storage.deleteDraftCas('anna', saved.draftId, 2), true)
  await assert.rejects(b.save(), DraftConflictError)
  assert.equal((await storage.drafts('anna')).some(row => row.draftId === saved.draftId), false)
})
test('CAS distinguishes a missing draft from stored revision zero, including legacy rows', async () => {
  const storage = new MemoryStorage(), zero = { ...manual(0), category: undefined }
  assert.equal(await storage.saveDraftCas(zero, 0), false)
  assert.equal(await storage.saveDraftCas(zero, null), true)
  assert.equal(await storage.saveDraftCas({ ...zero, revision: 1 }, null), false)
  assert.equal(await storage.saveDraftCas({ ...zero, revision: 1 }, 0), true)
  const legacy = session(storage, { ...zero, revision: 1 })
  legacy.change({ value: { title: 'Обновлён старый черновик' } }); await legacy.save()
  assert.equal(legacy.snapshot().draftId, zero.draftId)
})
test('late ACK/save cleanup captures the old buffer revision before awaiting writes and cannot delete a newer committed edit', async () => {
  const storage = new MemoryStorage(), started = deferred<void>(), release = deferred<void>(), secondCommitted = deferred<void>(), deleted = deferred<void>()
  const put = storage.saveDraft.bind(storage), remove = storage.deleteDraftCas.bind(storage)
  storage.saveDraft = async row => { if (row.revision === 1) { started.resolve(); await release.promise }; await put(row); if (row.revision === 2) secondCommitted.resolve() }
  const revisions: number[] = []
  storage.deleteDraftCas = async (user, id, revision) => { revisions.push(revision); await secondCommitted.promise; const result = await remove(user, id, revision); deleted.resolve(); return result }
  const editor = session(storage)
  editor.change({ value: { title: 'Отправлено' } }); await started.promise
  editor.acknowledge(structuredClone(editor.snapshot()))
  editor.change({ value: { title: 'Ввод после ACK' } }); release.resolve()
  await deleted.promise
  const buffer = (await storage.drafts('anna')).find(row => row.draftId === editor.bufferId)
  assert.deepEqual(revisions, [1]); assert.equal(buffer?.revision, 2)
  assert.deepEqual(buffer?.value, { title: 'Ввод после ACK' }); assert.equal(editor.dirty, true)
})
test('manual save snapshots its own input; newer editing during commit retains input and the old server base', async () => {
  const storage = new MemoryStorage(), saved = manual(), entered = deferred<void>(), commit = deferred<void>()
  await storage.saveDraft(saved)
  const put = storage.saveDraftCas.bind(storage)
  storage.saveDraftCas = async (row, expected) => { entered.resolve(); await commit.promise; return put(row, expected) }
  const editor = session(storage, saved)
  editor.change({ value: { title: 'Сохраняется' } })
  const saving = editor.save(); assert.equal(editor.save(), saving, 'synchronous double save shares one CAS')
  await entered.promise; editor.change({ value: { title: 'Новый ввод' } }); commit.resolve(); await saving; await editor.retryEmergency()
  assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === saved.draftId)?.value, { title: 'Сохраняется' })
  assert.deepEqual(editor.snapshot().value, { title: 'Новый ввод' }); assert.deepEqual(editor.snapshot().base, saved.base)
  assert.equal(editor.dirty, true); assert.equal(editor.snapshot().revision, 2)
})
test('immutable pending submission has its own recovery; ACK preserves manual, legacy and newer emergency records', async () => {
  const storage = new MemoryStorage(), saved = manual(), submitted = { ...saved, value: { title: 'Отправлено' }, editRevision: 1 }
  await storage.saveDraft(saved)
  const frozen = freezePending(captureCommand('anna', { method: 'POST', path: '/task-definitions', body: { title: 'Отправлено' } }), submitted, stream)
  await storage.reserve(frozen, submitted)
  submitted.value.title = 'Внешняя мутация'
  assert.deepEqual((await storage.getPending('anna'))?.submittedDraft.value, { title: 'Отправлено' })
  const recovery = (await storage.drafts('anna')).find(row => row.draftId === frozen.recoveryDraftId)!
  assert.deepEqual(recovery.value, { title: 'Отправлено' })
  const newer = { ...recovery, revision: 2, value: { title: 'Более новый буфер' } }
  await storage.saveDraft(newer); await storage.transition(frozen, null, true)
  assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === saved.draftId), saved)
  assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === recovery.draftId), newer)
  const legacySaved = { ...saved, category: undefined }
  await storage.saveDraftCas(legacySaved, saved.revision)
  const legacy = { ...freezePending(frozen.command, legacySaved, stream), recoveryDraftId: undefined, recoveryRevision: undefined }
  await storage.reserve(legacy, legacySaved); await storage.transition(legacy, null, true)
  assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === saved.draftId), legacySaved)
})
test('emergency restore edits the original manual ID without writes on open; save uses its captured CAS token', async () => {
  const storage = new MemoryStorage(), saved = manual()
  await storage.saveDraft(saved)
  const original = session(storage, saved)
  original.change({ value: { title: 'Аварийный ввод' } }); await original.retryEmergency()
  const rows = await storage.drafts('anna'), buffer = rows.find(row => row.category === 'emergency')!
  const restored = session(storage, buffer)
  assert.equal(restored.snapshot().draftId, saved.draftId); assert.equal(restored.dirty, true)
  assert.deepEqual(await storage.drafts('anna'), rows)
  await restored.save()
  const after = await storage.drafts('anna')
  assert.equal(after.length, 1); assert.equal(after[0]?.draftId, saved.draftId)
  assert.deepEqual(after[0]?.value, { title: 'Аварийный ввод' }); assert.equal(after[0]?.revision, 2)
})
test('leave dialog has continue/discard/save branches; discard removes only unsaved input, save callback rereads the updated same ID', async () => {
  const storage = new MemoryStorage(), saved = manual()
  await storage.saveDraft(saved)
  const { runtime, editor } = await account(storage, saved)
  editor.change({ value: { title: 'Первое изменение' } })
  let transitions = 0
  let leaving = runtime.requestLeave(() => { transitions++ })
  assert.equal(runtime.snapshot().leaveRequested, true); await runtime.decideLeave('continue')
  assert.equal(await leaving, false); assert.equal(transitions, 0); assert.equal(editor.dirty, true)
  leaving = runtime.requestLeave(() => { transitions++ }); await runtime.decideLeave('discard')
  assert.equal(await leaving, true); assert.equal(transitions, 1); assert.deepEqual(editor.snapshot().value, saved.value)
  assert.deepEqual((await storage.drafts('anna')).find(row => row.draftId === saved.draftId), saved)
  editor.change({ value: { title: 'Сохранён при переходе' } })
  let reopened: DraftRecord | undefined
  leaving = runtime.requestLeave(async () => { reopened = await runtime.latestDraft(saved.draftId); transitions++ })
  await runtime.decideLeave('save')
  assert.equal(await leaving, true); assert.equal(transitions, 2); assert.equal(reopened?.revision, 2)
  assert.deepEqual(reopened?.value, { title: 'Сохранён при переходе' }); runtime.stop()
})
test('quota or competing-tab CAS failure blocks navigation and preserves editor input', async () => {
  for (const failure of ['quota', 'cas']) {
    const storage = new MemoryStorage(), saved = manual(); await storage.saveDraft(saved)
    const { runtime, editor } = await account(storage, saved)
    editor.change({ value: { title: 'Не терять' } }); await editor.retryEmergency()
    if (failure === 'quota') storage.failWrites = true
    else await storage.saveDraftCas({ ...saved, revision: 2, value: { title: 'Другая вкладка' } }, 1)
    let moved = false
    const leaving = runtime.requestLeave(() => { moved = true })
    await runtime.decideLeave('save')
    assert.equal(moved, false); assert.equal(runtime.snapshot().leaveRequested, true); assert.ok(runtime.snapshot().leaveError)
    assert.deepEqual(editor.snapshot().value, { title: 'Не терять' })
    await runtime.decideLeave('continue'); assert.equal(await leaving, false); runtime.stop()
  }
})
test('identity switch while awaiting save hides the old runtime and never executes its navigation callback', async () => {
  const storage = new MemoryStorage(), entered = deferred<void>(), commit = deferred<void>()
  const put = storage.saveDraftCas.bind(storage)
  storage.saveDraftCas = async (row, expected) => { entered.resolve(); await commit.promise; return put(row, expected) }
  const { runtime, editor } = await account(storage)
  editor.change({ value: { title: 'Только Анне' } })
  let moved = false
  const leaving = runtime.requestLeave(() => { moved = true }), saving = runtime.decideLeave('save')
  await entered.promise; identityState.activate('boris'); runtime.stop(); commit.resolve(); await saving
  assert.equal(await leaving, false); assert.equal(moved, false); assert.equal(runtime.current(), false)
  assert.equal((await storage.drafts('boris')).length, 0)
  assert.deepEqual((await storage.drafts('anna')).find(row => row.category === 'manual')?.value, { title: 'Только Анне' })
})
test('new editing while leave-save is awaiting commit stops the transition and keeps the dialog open', async () => {
  const storage = new MemoryStorage(), entered = deferred<void>(), commit = deferred<void>()
  const put = storage.saveDraftCas.bind(storage)
  storage.saveDraftCas = async (row, expected) => { entered.resolve(); await commit.promise; return put(row, expected) }
  const { runtime, editor } = await account(storage)
  editor.change({ value: { title: 'Сохраняется' } })
  let moved = false
  const leaving = runtime.requestLeave(() => { moved = true }), saving = runtime.decideLeave('save')
  await entered.promise; editor.change({ value: { title: 'Ещё новее' } }); commit.resolve(); await saving
  assert.equal(moved, false); assert.equal(runtime.snapshot().leaveRequested, true); assert.equal(editor.dirty, true)
  assert.deepEqual(editor.snapshot().value, { title: 'Ещё новее' })
  await runtime.decideLeave('continue'); assert.equal(await leaving, false); runtime.stop()
})
test('native beforeunload is registered only as a dirty-input guard; pristine new-task leave still uses the internal dialog', async context => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window'), target = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  const storage = new MemoryStorage(), { runtime, editor } = await account(storage)
  context.mock.method(runtime.coordinator, 'start', () => undefined)
  context.mock.method(runtime.coordinator, 'stop', () => undefined)
  try {
    await runtime.start()
    assert.equal(runtime.hasUnsaved(), true)
    const pristine = new Event('beforeunload', { cancelable: true }); target.dispatchEvent(pristine)
    assert.equal(pristine.defaultPrevented, false)
    editor.change({ value: { title: 'Аварийно сохранится заранее' } }); await editor.retryEmergency()
    const changed = new Event('beforeunload', { cancelable: true }); target.dispatchEvent(changed)
    assert.equal(changed.defaultPrevented, true)
    assert.ok((await storage.drafts('anna')).some(row => row.category === 'emergency'))
    await editor.discard()
    const discarded = new Event('beforeunload', { cancelable: true }); target.dispatchEvent(discarded)
    assert.equal(discarded.defaultPrevented, false)
  } finally { runtime.stop(); if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') }
})

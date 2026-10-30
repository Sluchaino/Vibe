import test from 'node:test'
import assert from 'node:assert/strict'
import type { RecurrenceRule, SyncChange, SyncItem, TaskDefinition, TaskOccurrence } from '../src/api/types.ts'
import { ApiError, NetworkError } from '../src/api/client.ts'
import { AccountRuntime, freezePending } from '../src/sync/runtime.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { validateWire } from '../src/sync/validation.ts'
import { identityState } from '../src/state/session.ts'
import { CreationDefinitionChanged, prepareUnified, runUnifiedCreation, unifiedStage, type UnifiedIntent, type UnifiedRecord } from '../src/lib/unified-task.ts'
import { sameDraftRevision } from '../src/lib/durable-draft.ts'
import { DraftSession } from '../src/lib/draft-session.ts'
import { stopRecurrenceCommand } from '../src/lib/recurrence.ts'
import { MemoryStorage } from './storage-memory.ts'
import { bootstrap, delta, deferred, items, plan, stream } from './sync-fixture.ts'
import { occurrenceFixture } from './completion-fixture.ts'
import type { Command, PendingCommand as FrozenCommand } from '../src/lib/operations.ts'
import { captureCommand } from '../src/lib/operations.ts'

function intent(): UnifiedIntent {
  const { id, serverVersion: _version, ...template } = items()[1]!.value as TaskDefinition
  return { definitionId: id, occurrenceId: occurrenceFixture().id, definition: { ...template, durationPolicy: null, workOrigin: 'unspecified' }, logicalDate: null, timeIntent: null, schedule: null, definitionVersion: null }
}
function harness() {
  identityState.activate('anna')
  const storage = new MemoryStorage(), definitions = new Map<string, TaskDefinition>(), occurrences = new Map<string, TaskOccurrence>(), rules = new Map<string, RecurrenceRule>(), changes: SyncChange[] = [], commands: FrozenCommand[] = []
  let afterSend: ((command: FrozenCommand, actor: string) => void | Promise<void>) | undefined
  let readHook: ((actor: string, path: string, payload: unknown) => Promise<unknown>) | undefined
  const settings = items()[0]!
  function publish(item: SyncItem, command: FrozenCommand) { changes.push({ id: crypto.randomUUID(), opId: command.opId, item, planState: plan }) }
  function runtime(actor = 'main') {
    let offset = 0
    const coordinator = new SyncCoordinator('anna', async path => {
      const payload = path.startsWith('/sync/bootstrap')
        ? bootstrap({ items: [settings, ...[...definitions.values()].map(value => ({ kind: 'definition', value } as SyncItem)), ...[...occurrences.values()].map(value => ({ kind: 'occurrence', value } as SyncItem)), ...[...rules.values()].map(value => ({ kind: 'recurrence', value } as SyncItem))] })
        : delta({ changes: changes.slice(offset), nextCursor: crypto.randomUUID() })
      offset = changes.length
      return readHook ? await readHook(actor, path, payload) : payload
    })
    return new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => {
      commands.push(structuredClone(command))
      const durable = (await storage.drafts('anna')).find(row => row.key === `task-create:${intent().definitionId}`)
      assert.ok(durable, 'independent continuation transaction committed before every HTTP')
      assert.equal((await storage.getPending('anna'))?.opId, command.opId, 'only frozen reserved slot may send')
      if (command.path === '/task-definitions') {
        validateWire(command.body, 'CreateDefinitionRequestU1')
        const { opId: _op, ...fields } = command.body
        const definition = { ...fields, serverVersion: 'created_definition' } as unknown as TaskDefinition
        if (!definitions.has(definition.id)) { definitions.set(definition.id, definition); publish({ kind: 'definition', value: definition }, command) }
      } else if (command.path.endsWith('/occurrences')) {
        validateWire(command.body, 'CreateOccurrenceRequestU1')
        const id = command.body.id as string, definition = definitions.get(intent().definitionId)!
        assert.equal(command.body.definitionVersion, definition.serverVersion)
        const { durationPolicy, workOrigin, availabilityRules, mobilityPolicy, splitAllowed, placeId, requiredRestMinutes } = definition
        const occurrence: TaskOccurrence = { ...occurrenceFixture(null, false), id, definitionId: definition.id, sourceDefinitionVersion: definition.serverVersion, logicalDate: command.body.logicalDate as string | null, constraintsSnapshot: { durationPolicy, workOrigin, availabilityRules, mobilityPolicy, splitAllowed, placeId, requiredRestMinutes }, remainingWorkMinutes: definition.durationPolicy?.requiredWorkMinutes ?? null, timeIntent: command.body.timeIntent as TaskOccurrence['timeIntent'], serverVersion: 'created_occurrence' }
        if (!occurrences.has(id)) { occurrences.set(id, occurrence); publish({ kind: 'occurrence', value: occurrence }, command) }
      } else if (command.path.endsWith('/recurrence-rule')) {
        validateWire(command.body, 'CreateRecurrenceRuleRequestU1')
        const { opId: _op, definitionVersion: _version, ...fields } = command.body
        const rule = { ...fields, definitionId: intent().definitionId, enabled: true, generatedThrough: null, serverVersion: 'created_rule' } as RecurrenceRule
        if (!rules.has(rule.id)) { rules.set(rule.id, rule); publish({ kind: 'recurrence', value: rule }, command) }
      } else throw new Error('Unexpected command')
      await afterSend?.(command, actor)
      return { ignoredLegacyAck: true }
    })
  }
  return { storage, definitions, occurrences, rules, commands, runtime, setAfterSend: (callback?: typeof afterSend) => { afterSend = callback }, setReadHook: (callback: typeof readHook) => { readHook = callback } }
}
async function ready(runtime: AccountRuntime) { await runtime.coordinator.catchUp(); await runtime.reload() }

test('one Create commits independent intent before each HTTP and waits for a fresh definition ACK before occurrence, with null date/work preserved', async () => {
  const h = harness(), runtime = h.runtime()
  await ready(runtime)
  let record = prepareUnified('anna', intent())
  assert.equal(await runUnifiedCreation(runtime, 'new-task', record, () => true, next => { record = next }), true)
  assert.equal(h.commands.length, 2)
  assert.equal(h.commands[1]!.body.definitionVersion, 'created_definition')
  assert.equal(h.commands[1]!.body.logicalDate, null); assert.equal(h.commands[1]!.body.timeIntent, null)
  await runtime.reload()
  assert.equal(runtime.snapshot().pending, null)
  assert.equal(unifiedStage(runtime.coordinator.snapshot().projection!, record.value), 'done')
  const saved = await h.storage.drafts('anna')
  assert.equal(saved.find(row => row.draftId === record.draftId)?.revision, 2)
  assert.equal(h.occurrences.values().next().value?.remainingWorkMinutes, null)
  runtime.stop()
})

test('recurring Create makes definition→interval rule with shared hours and never creates an accidental manual occurrence', async () => {
  const h = harness(), runtime = h.runtime(); await ready(runtime)
  const value = intent()
  value.definition = { ...value.definition, workOrigin: 'interval' }
  value.timeIntent = { timezone: 'Europe/Berlin', startLocalTime: '23:00', endLocalTime: '01:00', endDayOffset: 1, startDisambiguation: null, endDisambiguation: null }
  value.schedule = { id: crypto.randomUUID(), pattern: 'interval', intervalDays: '3', daysOfWeek: [], timezone: 'Europe/Berlin', startDate: '2026-10-21', endDate: '2026-12-20' }
  assert.equal(await runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', value), () => true, () => undefined), true)
  assert.deepEqual(h.commands.map(command => command.path), ['/task-definitions', `/task-definitions/${value.definitionId}/recurrence-rule`])
  assert.equal(h.occurrences.size, 0); assert.equal(h.rules.size, 1)
  const rule = h.rules.values().next().value!
  assert.equal(rule.pattern, 'interval'); assert.deepEqual(rule.timeIntent, value.timeIntent)
  const stop = stopRecurrenceCommand(rule)
  assert.equal(stop.version, rule.serverVersion); assert.equal(stop.path, `/recurrence-rules/${rule.id}/stop`)
  runtime.stop()
})

test('crash after definition ACK but before continuation version capture restores from confirmed IDs and never repeats the definition', async () => {
  const h = harness(), runtime = h.runtime(); await ready(runtime)
  let active = true, saved = prepareUnified('anna', intent())
  h.setAfterSend(() => { active = false })
  assert.equal(await runUnifiedCreation(runtime, 'new-task', saved, () => active, record => { saved = record }), false)
  assert.equal(h.commands.length, 1); assert.equal(saved.value.definitionVersion, null)
  runtime.stop()
  h.setAfterSend()
  const restored = h.runtime(); await ready(restored)
  const record = (await h.storage.drafts('anna')).find(row => row.draftId === saved.draftId) as UnifiedRecord
  assert.equal(await runUnifiedCreation(restored, 'new-task', prepareUnified('anna', record.value, record), () => true, () => undefined), true)
  assert.equal(h.commands.filter(command => command.path === '/task-definitions').length, 1)
  const done = (await h.storage.drafts('anna')).find(row => row.draftId === record.draftId) as UnifiedRecord
  assert.equal(await runUnifiedCreation(restored, 'new-task', prepareUnified('anna', done.value, done), () => true, () => undefined), true)
  assert.equal(h.commands.length, 2, 'restore of a finished flow is read-only')
  restored.stop()
})

test('lost first ACK keeps one frozen pending; retry retains old method/body/opId then explicit continuation creates just the missing step', async () => {
  const h = harness(), runtime = h.runtime(); await ready(runtime)
  let saved = prepareUnified('anna', intent())
  h.setAfterSend(() => { throw new NetworkError('lost ACK') })
  await assert.rejects(runUnifiedCreation(runtime, 'new-task', saved, () => true, record => { saved = record }), NetworkError)
  const original = (await h.storage.getPending('anna'))!, frozen = JSON.stringify(original.command)
  assert.equal(original.status, 'unconfirmed'); assert.equal(h.commands.length, 1)
  await assert.rejects(runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', saved.value, saved), () => true, () => undefined))
  assert.equal(h.commands.length, 1)
  h.setAfterSend()
  await runtime.retry()
  assert.equal(JSON.stringify(h.commands[1]), frozen)
  const current = (await h.storage.drafts('anna')).find(row => row.draftId === saved.draftId) as UnifiedRecord
  assert.equal(await runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', current.value, current), () => true, () => undefined), true)
  assert.equal(h.definitions.size, 1); assert.equal(h.occurrences.size, 1)
  runtime.stop()
})

test('quota before the next durable step stops the chain after partial success; no dependent POST escapes', async () => {
  const h = harness(), runtime = h.runtime(); await ready(runtime)
  let writes = 0
  const save = h.storage.saveDraftCas.bind(h.storage)
  h.storage.saveDraftCas = async (...args) => { if (++writes === 2) throw new Error('quota'); return save(...args) }
  await assert.rejects(runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', intent()), () => true, () => undefined), /quota/)
  assert.equal(h.commands.length, 1); assert.equal(h.definitions.size, 1); assert.equal(h.occurrences.size, 0)
  assert.ok((await h.storage.drafts('anna')).some(row => row.category === 'continuation'))
  runtime.stop()
})

test('owner/401 change after dispatch retains original pending and prevents every later step', async () => {
  const h = harness(), runtime = h.runtime(); await ready(runtime)
  h.setAfterSend(() => { identityState.activate('boris'); throw new ApiError({ status: 401, code: 'unauthorized' } as never) })
  await assert.rejects(runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', intent()), () => true, () => undefined))
  assert.equal(h.commands.length, 1); assert.equal((await h.storage.getPending('anna'))?.status, 'unconfirmed'); assert.equal(await h.storage.getPending('boris'), null)
  runtime.stop()
})

test('a saved definition changed after a crash requires explicit version review rather than silently accepting fresh conditions', async () => {
  const h = harness(), runtime = h.runtime(), value = intent()
  h.definitions.set(value.definitionId, { ...value.definition, id: value.definitionId, title: 'Другая редакция', serverVersion: 'edited' })
  await ready(runtime)
  await assert.rejects(runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', value), () => true, () => undefined), CreationDefinitionChanged)
  assert.equal(h.commands.length, 0)
  const reviewed = { ...value, definitionVersion: 'edited' }
  assert.equal(await runUnifiedCreation(runtime, 'new-task', prepareUnified('anna', reviewed), () => true, () => undefined), true)
  assert.equal(h.commands[0]!.body.definitionVersion, 'edited')
  runtime.stop()
})

test('changing unified repetition is an edit in the same session and manual CAS id; opening/closing unchanged never writes a new draft', async () => {
  const h = harness()
  const original = { id: 'stable', repeat: 'none', timing: { logicalDate: '' } }
  const session = new DraftSession('anna', 'new-task', original, null, null, async () => h.storage, () => undefined, 'tab')
  const id = session.snapshot().draftId
  assert.equal((await h.storage.drafts('anna')).length, 0)
  session.change({ value: { ...original, repeat: 'interval' } })
  assert.equal(session.snapshot().draftId, id); assert.equal(session.dirty, true)
  await session.save()
  const saved = (await h.storage.drafts('anna')).find(row => row.category === 'manual')!
  const reopened = new DraftSession('anna', 'new-task', original, null, saved, async () => h.storage, () => undefined, 'tab2')
  await reopened.discard()
  assert.equal(reopened.snapshot().draftId, id)
  assert.equal((await h.storage.drafts('anna')).filter(row => row.category === 'manual').length, 1)
})

test('pre-U1 frozen definition, occurrence, rule and completion retries retain original bytes after fresh s3 reload and legacy ACK', async () => {
  const commands: Command[] = [
    { method: 'POST', path: '/task-definitions', body: { id: intent().definitionId, title: 'Старая задача', durationPolicy: { mode: 'fixedWork', requiredWorkMinutes: 60 } } },
    { method: 'POST', path: `/task-definitions/${intent().definitionId}/occurrences`, body: { id: intent().occurrenceId, definitionVersion: 'old_def', logicalDate: '2026-10-21' } },
    { method: 'POST', path: `/task-definitions/${intent().definitionId}/recurrence-rule`, body: { id: crypto.randomUUID(), definitionVersion: 'old_def', pattern: 'weekly', daysOfWeek: ['monday'], timezone: 'Europe/Berlin', startDate: '2026-10-21', endDate: null } },
    { method: 'POST', path: `/occurrences/${intent().occurrenceId}/completion/reopen`, version: 'old_occ', body: { completionId: crypto.randomUUID() } },
  ]
  for (const input of commands) {
    identityState.activate('anna')
    const storage = new MemoryStorage(), sent: string[] = []
    const coordinator = () => new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
    const first = new AccountRuntime('anna', Promise.resolve(storage), coordinator(), async command => { sent.push(JSON.stringify(command)); throw new NetworkError('lost pre-U1 ACK') })
    await ready(first)
    await assert.rejects(first.submit('legacy-editor', input), NetworkError)
    const original = JSON.stringify((await storage.getPending('anna'))!.command)
    first.stop()
    const reopened = new AccountRuntime('anna', Promise.resolve(storage), coordinator(), async command => { sent.push(JSON.stringify(command)); return { occurrence: { legacyReplay: true } } })
    await ready(reopened); await reopened.retry()
    assert.deepEqual(sent, [original, original])
    assert.equal(await storage.getPending('anna'), null)
    const body = JSON.parse(original).body as Record<string, unknown>
    assert.equal(Object.hasOwn(body, 'workOrigin'), false); assert.equal(Object.hasOwn(body, 'timeIntent'), false)
    reopened.stop()
  }
})

function attachDirtyEditor(runtime: AccountRuntime, value: UnifiedIntent) {
  const session = runtime.createSession('new-task', { title: '' }, null, null)
  session.change({ value: { title: value.definition.title } })
  runtime.editors.set('new-task', session.snapshot); runtime.sessions.add(session)
  return session
}

test('two runtimes: a polling peer releases both shared ACKs first; the sender still completes the chain and its exact editor is settled', async () => {
  const h = harness(), writer = h.runtime('writer'), reader = h.runtime('reader')
  await ready(writer); await ready(reader)
  const value = intent(), editor = attachDirtyEditor(writer, value), submitted = editor.snapshot()
  const barriers = [0, 1].map(() => ({ entered: deferred<void>(), release: deferred<void>() }))
  let index = 0
  h.setReadHook(async (actor, path, payload) => {
    if (actor === 'writer' && !path.startsWith('/sync/bootstrap') && (await h.storage.getPending('anna'))?.status === 'acknowledgedRefresh') {
      const barrier = barriers[index++]!
      barrier.entered.resolve(); await barrier.release.promise
    }
    return payload
  })
  const flow = runUnifiedCreation(writer, 'new-task', prepareUnified('anna', value), () => sameDraftRevision(editor.snapshot(), submitted), () => undefined)
  for (const barrier of barriers) {
    await barrier.entered.promise
    assert.equal((await h.storage.getPending('anna'))?.status, 'acknowledgedRefresh')
    await reader.reconcile()
    assert.equal(await h.storage.getPending('anna'), null, 'peer obtained a fresh tail and won the shared CAS cleanup')
    barrier.release.resolve()
  }
  assert.equal(await flow, true)
  assert.equal(h.commands.length, 2); assert.equal(h.definitions.size, 1); assert.equal(h.occurrences.size, 1)
  assert.equal(editor.dirty, false); assert.equal(writer.hasUnsaved(), false)
  let navigated = false
  assert.equal(await writer.requestLeave(() => { navigated = true }), true); assert.equal(navigated, true); assert.equal(writer.snapshot().leaveRequested, false)
  writer.stop(); reader.stop()
})

test('two runtimes: peer cleanup followed by new A2/new input cannot be cleared or settled by late A1 and stops the dependent command', async () => {
  const h = harness(), writer = h.runtime('writer'), reader = h.runtime('reader')
  await ready(writer); await ready(reader)
  const value = intent(), editor = attachDirtyEditor(writer, value)
  const entered = deferred<void>(), release = deferred<void>()
  h.setReadHook(async (actor, path, payload) => {
    if (actor === 'writer' && !path.startsWith('/sync/bootstrap') && (await h.storage.getPending('anna'))?.status === 'acknowledgedRefresh') { entered.resolve(); await release.promise }
    return payload
  })
  const flow = runUnifiedCreation(writer, 'new-task', prepareUnified('anna', value), () => true, () => undefined)
  await entered.promise; await reader.reconcile()
  editor.change({ value: { title: 'Новый ввод после A1' } }); await editor.retryEmergency()
  const newer = editor.snapshot(), replacement = freezePending(captureCommand('anna', { method: 'PUT', path: `/task-definitions/${value.definitionId}`, version: 'new_base', body: { title: 'A2' } }), newer, stream)
  assert.equal(await h.storage.reserve(replacement, newer), true)
  const frozen = JSON.stringify(await h.storage.getPending('anna')), drafts = JSON.stringify(await h.storage.drafts('anna'))
  release.resolve()
  assert.equal(await flow, false)
  assert.equal(h.commands.length, 1)
  assert.equal(JSON.stringify(await h.storage.getPending('anna')), frozen)
  assert.equal(JSON.stringify(await h.storage.drafts('anna')), drafts)
  assert.equal(editor.dirty, true); assert.deepEqual(editor.snapshot().value, { title: 'Новый ввод после A1' })
  writer.stop(); reader.stop()
})

test('two runtimes: identity change while the original post-ACK tail waits never settles old private input or starts a later step', async () => {
  const h = harness(), writer = h.runtime('writer'), reader = h.runtime('reader')
  await ready(writer); await ready(reader)
  const value = intent(), editor = attachDirtyEditor(writer, value)
  const entered = deferred<void>(), release = deferred<void>()
  h.setReadHook(async (actor, path, payload) => {
    if (actor === 'writer' && !path.startsWith('/sync/bootstrap') && (await h.storage.getPending('anna'))?.status === 'acknowledgedRefresh') { entered.resolve(); await release.promise }
    return payload
  })
  const flow = runUnifiedCreation(writer, 'new-task', prepareUnified('anna', value), () => true, () => undefined)
  await entered.promise; await reader.reconcile()
  identityState.activate('boris'); release.resolve()
  await assert.rejects(flow)
  assert.equal(h.commands.length, 1); assert.equal(editor.dirty, true)
  assert.equal((await h.storage.drafts('boris')).length, 0)
  assert.equal(writer.current(), false)
  writer.stop(); reader.stop()
})

test('a vanished unconfirmed slot without a received HTTP ACK is never sufficient to acknowledge the editor or advance a chain', async () => {
  const h = harness(), writer = h.runtime(); await ready(writer)
  const value = intent(), editor = attachDirtyEditor(writer, value), entered = deferred<void>(), release = deferred<void>()
  h.setAfterSend(async () => { entered.resolve(); await release.promise; throw new NetworkError('No ACK') })
  const flow = runUnifiedCreation(writer, 'new-task', prepareUnified('anna', value), () => true, () => undefined)
  await entered.promise
  const pending = (await h.storage.getPending('anna'))!
  assert.equal(pending.status, 'unconfirmed'); await h.storage.transition(pending, null)
  release.resolve()
  await assert.rejects(flow, NetworkError)
  assert.equal(h.commands.length, 1); assert.equal(editor.dirty, true)
  writer.stop()
})

test('two HTTPs: peer retries the same unconfirmed operation and releases it before the original ACK; the original sender still completes its fresh-tail chain', async () => {
  const h = harness(), writer = h.runtime('writer'), reader = h.runtime('reader')
  await ready(writer); await ready(reader)
  const value = intent()
  value.schedule = { id: crypto.randomUUID(), pattern: 'interval', intervalDays: '2', daysOfWeek: [], timezone: 'Europe/Berlin', startDate: '2026-11-01', endDate: '2026-11-03' }
  const editor = attachDirtyEditor(writer, value), submitted = editor.snapshot(), entered = deferred<void>(), release = deferred<void>()
  h.setAfterSend(async (command, actor) => {
    if (actor === 'writer' && command.path === '/task-definitions') { entered.resolve(); await release.promise }
  })
  const flow = runUnifiedCreation(writer, 'new-task', prepareUnified('anna', value), () => sameDraftRevision(editor.snapshot(), submitted), () => undefined)
  await entered.promise
  assert.equal((await h.storage.getPending('anna'))?.status, 'unconfirmed')
  await reader.retry()
  assert.equal(await h.storage.getPending('anna'), null)
  assert.equal(JSON.stringify(h.commands[0]), JSON.stringify(h.commands[1]), 'peer retries exactly the frozen original HTTP')
  release.resolve()
  assert.equal(await flow, true)
  assert.equal(h.commands.length, 3); assert.ok(h.commands[2]!.path.endsWith('/recurrence-rule'))
  assert.equal(h.definitions.size, 1); assert.equal(h.rules.size, 1); assert.equal(h.occurrences.size, 0)
  assert.equal(editor.dirty, false); assert.equal(writer.hasUnsaved(), false)
  writer.stop(); reader.stop()
})

test('two HTTPs: a new A2 and later draft created after peer retry wins are preserved when the original ACK loses its first CAS', async () => {
  const h = harness(), writer = h.runtime('writer'), reader = h.runtime('reader')
  await ready(writer); await ready(reader)
  const value = intent(), editor = attachDirtyEditor(writer, value), entered = deferred<void>(), release = deferred<void>()
  h.setAfterSend(async (command, actor) => {
    if (actor === 'writer' && command.path === '/task-definitions') { entered.resolve(); await release.promise }
  })
  const flow = runUnifiedCreation(writer, 'new-task', prepareUnified('anna', value), () => true, () => undefined)
  await entered.promise; await reader.retry()
  editor.change({ value: { title: 'Новая редакция после peer ACK' } }); await editor.retryEmergency()
  const newer = editor.snapshot(), replacement = freezePending(captureCommand('anna', { method: 'PUT', path: `/task-definitions/${value.definitionId}`, version: 'next_base', body: { title: 'A2' } }), newer, stream)
  assert.equal(await h.storage.reserve(replacement, newer), true)
  const frozen = JSON.stringify(await h.storage.getPending('anna')), drafts = JSON.stringify(await h.storage.drafts('anna'))
  release.resolve()
  assert.equal(await flow, false)
  assert.equal(h.commands.length, 2, 'only the original request and its exact peer retry were sent')
  assert.equal(JSON.stringify(await h.storage.getPending('anna')), frozen); assert.equal(JSON.stringify(await h.storage.drafts('anna')), drafts)
  assert.equal(editor.dirty, true); assert.deepEqual(editor.snapshot().value, { title: 'Новая редакция после peer ACK' })
  writer.stop(); reader.stop()
})

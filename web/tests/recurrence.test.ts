import test from 'node:test'
import assert from 'node:assert/strict'
import type { RecurrenceRule, SyncChange, SyncItem, TaskDefinition } from '../src/api/types.ts'
import type { DraftRecord } from '../src/persistence/database.ts'
import { createRecurrenceCommand, defaultRecurrence, isRecurringRecord, prepareRecurring, recurrenceInput, recurrenceStopRestoration, recurringRestoration, recurringStage, stopRecurrenceCommand } from '../src/lib/recurrence.ts'
import { AccountRuntime } from '../src/sync/runtime.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { emptyProjection, recurrenceForDefinition, replaceItems } from '../src/sync/projection.ts'
import { validateWire } from '../src/sync/validation.ts'
import { identityState } from '../src/state/session.ts'
import { ApiError, NetworkError } from '../src/api/client.ts'
import { MemoryStorage } from './storage-memory.ts'
import { bootstrap, delta, deferred, items, plan, stream } from './sync-fixture.ts'
import { completionA, occurrenceFixture } from './completion-fixture.ts'
import { rule } from './recurrence-fixture.ts'

const definition = () => items()[1]!.value as TaskDefinition
const projection = () => replaceItems(emptyProjection(plan, 'a', stream, 1), items(), plan, 'a')
function draft(key: string, value: unknown, base: unknown): DraftRecord { return { userId: 'anna', draftId: crypto.randomUUID(), key, category: 'manual', value, base, revision: 2, updatedAt: 1 } }

test('recurrence input validates weekdays/civil ranges/IANA without inventing time or UTC offsets, including leap and years 1/9999', () => {
  const schedule = defaultRecurrence('Europe/Berlin', '2026-03-29')
  const input = recurrenceInput({ ...schedule, daysOfWeek: ['sunday', 'monday'], endDate: '2026-10-25' })
  assert.deepEqual(input.daysOfWeek, ['monday', 'sunday']); assert.equal(input.endDate, '2026-10-25')
  assert.equal(Object.hasOwn(input, 'localStart'), false); assert.equal(Object.hasOwn(input, 'utcOffset'), false)
  for (const date of ['0001-01-01', '2024-02-29', '9999-12-31']) assert.equal(recurrenceInput({ ...schedule, startDate: date, endDate: date }).startDate, date)
  for (const value of [{ ...schedule, daysOfWeek: [] }, { ...schedule, daysOfWeek: ['monday', 'monday'] as const }, { ...schedule, startDate: '2025-02-29' }, { ...schedule, startDate: '0000-01-01' }, { ...schedule, endDate: '2026-03-28' }, { ...schedule, timezone: '+03:00' }]) assert.throws(() => recurrenceInput(value as typeof schedule))
  const command = createRecurrenceCommand(definition(), schedule)
  assert.doesNotThrow(() => validateWire({ ...command.body, opId: crypto.randomUUID() }, 'CreateRecurrenceRuleRequest'))
  assert.throws(() => validateWire({ ...command.body, opId: crypto.randomUUID(), localStart: '09:00' }, 'CreateRecurrenceRuleRequest'))
})
test('durable recurring creation survives definition ACK/reload and creates only an explicit rule, with generated no-time occurrences and stopped history membership', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), template = definition(), schedule = defaultRecurrence('Europe/Berlin', '2026-10-19')
  const intent = prepareRecurring('anna', template.id, schedule), changes: SyncChange[] = [], commands: string[] = []
  let savedDefinition: TaskDefinition | null = null, savedRule: RecurrenceRule | null = null
  const generated = [2, 3].map(index => ({ ...occurrenceFixture(null, false), id: `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`, logicalDate: index === 2 ? '2026-10-19' : '2026-10-20' }))
  const make = () => {
    const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap({ items: [items()[0]!, ...(savedDefinition ? [{ kind: 'definition', value: savedDefinition } as SyncItem] : []), ...(savedRule ? [...generated.map(value => ({ kind: 'occurrence', value }) as SyncItem), { kind: 'recurrence', value: savedRule } as SyncItem] : [])] }) : delta({ changes: changes.splice(0) }))
    return new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => {
      commands.push(command.path)
      assert.ok((await storage.drafts('anna')).some(row => row.draftId === intent.draftId))
      if (command.path === '/task-definitions') { savedDefinition = { ...template, serverVersion: 'created_def' }; changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'definition', value: savedDefinition }, planState: plan }) }
      else { assert.equal(command.body.definitionVersion, 'created_def'); assert.doesNotThrow(() => validateWire(command.body, 'CreateRecurrenceRuleRequest')); savedRule = rule({ id: schedule.id, daysOfWeek: schedule.daysOfWeek }); changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'recurrence', value: savedRule }, planState: plan }, ...generated.map(value => ({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'occurrence' as const, value }, planState: plan }))) }
      return { legacyAckIgnored: true }
    })
  }
  let active = make(); await active.coordinator.catchUp(); await active.reload(); await active.saveDraftAndWait(intent)
  await active.submit('new-recurring-definition', { method: 'POST', path: '/task-definitions', body: { id: template.id, title: template.title } })
  active.stop(); active = make(); await active.coordinator.catchUp(); await active.reload()
  const restored = active.snapshot().drafts.find(isRecurringRecord)!
  assert.equal(restored.draftId, intent.draftId); assert.equal(recurringStage(active.coordinator.snapshot().projection!, restored.value), 'createRule')
  assert.equal(commands.length, 1)
  await active.submit(`create-recurrence:${template.id}`, createRecurrenceCommand(savedDefinition!, restored.value.schedule))
  assert.equal(recurringStage(active.coordinator.snapshot().projection!, restored.value), 'rule')
  assert.equal(active.coordinator.snapshot().projection?.occurrences.size, 2)
  assert.ok([...active.coordinator.snapshot().projection!.occurrences.values()].every(value => value.calendarBlock === null && value.completion === null && value.remainingWorkMinutes === 90))
  assert.deepEqual(commands, ['/task-definitions', `/task-definitions/${template.id}/recurrence-rule`])
  const stopped = replaceItems(active.coordinator.snapshot().projection!, [{ kind: 'recurrence', value: { ...savedRule!, enabled: false } }], plan, 'stop')
  assert.equal(recurringStage(stopped, restored.value), 'rule'); assert.equal(recurrenceForDefinition(stopped, template.id)?.enabled, false)
  active.stop()
})
test('recurring continuation commit is awaited before the first send and quota failure preserves input with no POST', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), gate = deferred<void>(), entered = deferred<void>(), original = storage.saveDraftCas.bind(storage)
  storage.saveDraftCas = async (row, expected) => { entered.resolve(); await gate.promise; return original(row, expected) }
  let sends = 0
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async () => { sends++ })
  await coordinator.catchUp(); await runtime.reload()
  const value = prepareRecurring('anna', definition().id, defaultRecurrence('Europe/Berlin', '2026-10-17'))
  const sending = (async () => { await runtime.saveDraftAndWait(value); await runtime.submit('new-recurring-definition', { method: 'POST', path: '/task-definitions', body: {} }) })()
  await entered.promise; assert.equal(sends, 0); storage.failWrites = true; gate.resolve()
  await assert.rejects(sending, /quota/); assert.equal(sends, 0); assert.equal(value.value.schedule.startDate, '2026-10-17'); runtime.stop()
})
test('all new recurrence draft keys restore without writes/clones; owner/missing targets are rejected and saved bases survive newer shadow', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), schedule = defaultRecurrence('Europe/Berlin', '2026-10-17'), continuation = prepareRecurring('anna', definition().id, schedule)
  const state = replaceItems(projection(), [{ kind: 'recurrence', value: rule({ serverVersion: 'worker_v2' }) }], plan, 'worker')
  const source = draft('new-recurring-definition', { id: definition().id, recurrence: schedule, title: 'Сохранённый ввод' }, null)
  const creating = draft(`create-recurrence:${definition().id}`, schedule, definition())
  const stopping = draft(`recurrence-stop:${rule().id}`, { confirmed: true }, rule())
  await storage.saveDraft(continuation)
  for (const record of [source, creating, stopping]) {
    await storage.saveDraft(record)
    const before = await storage.drafts('anna'), runtime = new AccountRuntime('anna', Promise.resolve(storage))
    for (const emergency of [false, true]) {
      const selected = emergency ? { ...record, category: 'emergency' as const, draftId: 'buffer:' + record.draftId, sourceDraftId: record.draftId, expectedRevision: record.revision } : record
      if (record === stopping) { assert.equal(recurrenceStopRestoration('anna', selected, state)?.rule.serverVersion, 'worker_v2'); assert.equal(recurrenceStopRestoration('boris', selected, state), undefined) }
      else { assert.equal(recurringRestoration('anna', selected, before, state)?.draftId, continuation.draftId); assert.equal(recurringRestoration('boris', selected, before, state), undefined) }
      const session = runtime.createSession(record.key, {}, { newer: true }, selected)
      assert.equal(session.snapshot().draftId, record.draftId); assert.deepEqual(session.snapshot().base, record.base)
      assert.deepEqual(session.snapshot().value, record.value); assert.deepEqual(await storage.drafts('anna'), before)
    }
    runtime.stop()
  }
  assert.equal(recurringRestoration('anna', creating, [], state), undefined)
  assert.equal(recurrenceStopRestoration('anna', stopping, projection()), undefined)
  assert.equal(recurringRestoration('anna', creating, await storage.drafts('anna'), { ...state, definitions: new Map() }), undefined)
})
test('lost rule ACK retries its frozen original days/definitionVersion/opId while newer local edits remain separate', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), schedule = defaultRecurrence('Europe/Berlin', '2026-10-17'), commands: unknown[] = []
  const changes: SyncChange[] = []
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta({ changes: changes.splice(0) }))
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => { commands.push(structuredClone(command)); if (commands.length === 1) { changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'recurrence', value: rule({ id: schedule.id }) }, planState: plan }); throw new NetworkError('lost rule ACK') } })
  await coordinator.catchUp(); await runtime.reload()
  const session = runtime.createSession(`create-recurrence:${definition().id}`, schedule, definition(), null)
  runtime.sessions.add(session); runtime.editors.set(session.snapshot().key, session.snapshot)
  await assert.rejects(runtime.submit(session.snapshot().key, createRecurrenceCommand(definition(), schedule)))
  const pending = (await storage.getPending('anna'))!
  session.change({ value: { ...schedule, daysOfWeek: ['sunday'] } }); await session.retryEmergency()
  await runtime.retry()
  assert.deepEqual(commands[0], commands[1]); assert.deepEqual((commands[1] as typeof pending.command).body.daysOfWeek, schedule.daysOfWeek)
  assert.deepEqual((session.snapshot().value as typeof schedule).daysOfWeek, ['sunday']); assert.equal(session.dirty, true)
  assert.equal((await storage.drafts('anna')).some(row => row.sourceDraftId === session.snapshot().draftId && !row.pendingOpId), true)
  runtime.stop()
})
test('stale definition requires resolving the old pending and an explicit new base; new rule attempt has a new opId with the same rule ID', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), schedule = defaultRecurrence('Europe/Berlin', '2026-10-17'), changes: SyncChange[] = [], commands: { opId: string; version: unknown; id: unknown }[] = []
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta({ changes: changes.splice(0) }))
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => { commands.push({ opId: command.opId, version: command.body.definitionVersion, id: command.body.id }); if (commands.length === 1) { changes.push({ id: crypto.randomUUID(), opId: crypto.randomUUID(), item: { kind: 'definition', value: { ...definition(), serverVersion: 'definition_v2' } }, planState: plan }); throw new ApiError({ status: 412, code: 'staleDefinition' } as never) }; changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'recurrence', value: rule({ id: schedule.id }) }, planState: plan }) })
  await coordinator.catchUp(); await runtime.reload()
  const editor = runtime.createSession(`create-recurrence:${definition().id}`, schedule, definition(), null)
  runtime.sessions.add(editor); runtime.editors.set(editor.snapshot().key, editor.snapshot)
  await assert.rejects(runtime.submit(editor.snapshot().key, createRecurrenceCommand(editor.snapshot().base as TaskDefinition, schedule)))
  assert.equal((await storage.getPending('anna'))?.status, 'conflict'); assert.equal((editor.snapshot().base as TaskDefinition).serverVersion, 'definition_v1')
  await runtime.resolveRejection(); editor.change({ base: coordinator.snapshot().projection!.definitions.get(definition().id)! })
  await runtime.submit(editor.snapshot().key, createRecurrenceCommand(editor.snapshot().base as TaskDefinition, editor.snapshot().value as typeof schedule))
  assert.notEqual(commands[0]?.opId, commands[1]?.opId); assert.equal(commands[1]?.version, 'definition_v2'); assert.equal(commands[0]?.id, commands[1]?.id)
  runtime.stop()
})
test('stop stale worker version is reviewed before a fresh op; stopped rule preserves future occurrences, block, completion and schedule revision', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), changes: SyncChange[] = [], source = rule(), commands: { id: string; version: string | undefined }[] = []
  const future = { ...occurrenceFixture(null, false), id: '80000000-0000-4000-8000-000000000002', logicalDate: '2026-11-02' }, completed = occurrenceFixture(completionA)
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap({ items: [...items().slice(0, 2), { kind: 'occurrence', value: completed }, { kind: 'occurrence', value: future }, { kind: 'recurrence', value: source }] }) : delta({ changes: changes.splice(0) }))
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => { commands.push({ id: command.opId, version: command.version }); assert.deepEqual(Object.keys(command.body), ['opId']); if (commands.length === 1) { changes.push({ id: crypto.randomUUID(), opId: crypto.randomUUID(), item: { kind: 'recurrence', value: rule({ serverVersion: 'rule_2', generatedThrough: '2026-11-17' }) }, planState: plan }); throw new ApiError({ status: 412, code: 'staleEntity' } as never) }; changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'recurrence', value: rule({ enabled: false, serverVersion: 'rule_3', generatedThrough: '2026-11-17' }) }, planState: plan }) })
  await coordinator.catchUp(); await runtime.reload()
  const editor = runtime.createSession(`recurrence-stop:${source.id}`, { confirmed: true }, source, null)
  runtime.sessions.add(editor); runtime.editors.set(editor.snapshot().key, editor.snapshot)
  const before = coordinator.snapshot().projection!
  await assert.rejects(runtime.submit(editor.snapshot().key, stopRecurrenceCommand(editor.snapshot().base as RecurrenceRule)))
  assert.equal((editor.snapshot().base as RecurrenceRule).serverVersion, 'rule_1')
  await runtime.resolveRejection(); editor.change({ base: coordinator.snapshot().projection!.recurrences.get(source.id)!, value: { confirmed: false } }); editor.change({ value: { confirmed: true } })
  await runtime.submit(editor.snapshot().key, stopRecurrenceCommand(editor.snapshot().base as RecurrenceRule))
  const after = coordinator.snapshot().projection!
  assert.equal(after.recurrences.get(source.id)?.enabled, false); assert.deepEqual(after.occurrences, before.occurrences)
  assert.equal(after.planState.scheduleVersion, before.planState.scheduleVersion); assert.notEqual(commands[0]?.id, commands[1]?.id); assert.equal(commands[1]?.version, 'rule_2')
  runtime.stop()
})

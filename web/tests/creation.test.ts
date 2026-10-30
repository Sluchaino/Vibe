import test from 'node:test'
import assert from 'node:assert/strict'
import type { DraftRecord } from '../src/persistence/database.ts'
import type { SyncChange, SyncItem, TaskDefinition, TaskOccurrence } from '../src/api/types.ts'
import { creationStage, isCreationRecord, prepareCreation, resolvedCreationStart } from '../src/lib/creation.ts'
import { initialPlacementStart } from '../src/lib/placement-draft.ts'
import { resolveLocalTime } from '../src/lib/time.ts'
import { AccountRuntime } from '../src/sync/runtime.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { emptyProjection, replaceItems, selectCalendar, selectDateOnly } from '../src/sync/projection.ts'
import { identityState } from '../src/state/session.ts'
import { NetworkError } from '../src/api/client.ts'
import { MemoryStorage } from './storage-memory.ts'
import { bootstrap, deferred, delta, items, plan, stream } from './sync-fixture.ts'
import { occurrenceFixture, completionA } from './completion-fixture.ts'
import type { PendingCommand } from '../src/lib/operations.ts'

function editor(key: string, value: unknown, base: unknown): DraftRecord { return { userId: 'anna', draftId: crypto.randomUUID(), key, value, base, revision: 1, updatedAt: Date.now() } }
test('calendar date and independent continuation survive ACK cleanup/reload at every explicit step without duplicate definition', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage()
  const definitionTemplate = items().find(item => item.kind === 'definition')!.value as TaskDefinition
  const intent = prepareCreation('anna', definitionTemplate.id, '2026-10-20')
  const server: SyncItem[] = [items()[0]!]
  const changes: SyncChange[] = []
  const commands: PendingCommand[] = []
  let tail = 0
  function enqueue(item: SyncItem, opId: string) { server.push(item); changes.push({ id: crypto.randomUUID(), opId, item, planState: plan }) }
  function account() {
    const coordinator = new SyncCoordinator('anna', async path => {
      if (path.startsWith('/sync/bootstrap')) return bootstrap({ items: structuredClone(server) })
      return delta({ changes: changes.splice(0), nextCursor: `tail_${++tail}` })
    })
    return new AccountRuntime('anna', Promise.resolve(storage), coordinator, async (command, guard) => {
      guard(); commands.push(structuredClone(command))
      assert.ok((await storage.drafts('anna')).some(record => record.draftId === intent.draftId), 'durable continuation must precede every POST')
      if (command.path === '/task-definitions') {
        assert.equal(command.body.logicalDate, undefined)
        assert.equal(command.body.firstOccurrenceDate, undefined)
        enqueue({ kind: 'definition', value: { ...definitionTemplate, id: intent.value.definitionId, serverVersion: 'created_definition' } }, command.opId)
      } else if (command.path.endsWith('/occurrences')) {
        assert.equal(command.body.definitionVersion, 'created_definition')
        enqueue({ kind: 'occurrence', value: { ...occurrenceFixture(null, false), id: intent.value.occurrenceId, logicalDate: command.body.logicalDate as string, serverVersion: 'created_occurrence' } }, command.opId)
      } else {
        const prior = server.find(item => item.kind === 'occurrence')!.value as TaskOccurrence
        const { instant } = resolveLocalTime(command.body.localStart as string, command.body.timezone as string, command.body.utcOffset as string)
        const updated: SyncItem = { kind: 'occurrence', value: { ...prior, placementStatus: 'planned', calendarBlock: { ...occurrenceFixture().calendarBlock!, occurrenceId: prior.id, startInstant: instant, endInstant: new Date(Date.parse(instant) + 90 * 60000).toISOString().replace('.000Z', 'Z') }, serverVersion: 'placed_occurrence' } }
        server.splice(server.findIndex(item => item.kind === 'occurrence'), 1)
        enqueue(updated, command.opId)
      }
      return { data: { ignoredAckBody: true } }
    })
  }
  let active = account(); await active.coordinator.catchUp(); await active.reload()
  await active.saveDraftAndWait(intent)
  const definitionDraft = editor('new-definition', { id: intent.value.definitionId, firstOccurrenceDate: intent.value.logicalDate }, undefined)
  active.editors.set('new-definition', () => definitionDraft)
  await active.submit('new-definition', { method: 'POST', path: '/task-definitions', body: { id: intent.value.definitionId, title: definitionTemplate.title } })
  assert.equal(creationStage(active.coordinator.snapshot().projection!, intent.value), 'occurrence')
  assert.ok(!(await storage.drafts('anna')).some(record => record.draftId === definitionDraft.draftId))
  active.stop() // No afterSuccess callback is needed for recovery.
  active = account(); await active.coordinator.catchUp(); await active.reload()
  const recovered = active.snapshot().drafts.find(isCreationRecord)!
  assert.equal(recovered.value.logicalDate, '2026-10-20')
  assert.equal(creationStage(active.coordinator.snapshot().projection!, recovered.value), 'occurrence')
  assert.equal(commands.length, 1) // Restore and reads never post another definition.
  const changedDate = prepareCreation('anna', recovered.value.definitionId, '2026-10-21', recovered)
  await active.saveDraftAndWait(changedDate)
  assert.equal(changedDate.value.occurrenceId, recovered.value.occurrenceId)
  const base = active.coordinator.snapshot().projection!.definitions.get(recovered.value.definitionId)!
  const occurrenceDraft = editor(`create-occurrence:${base.id}`, { id: recovered.value.occurrenceId, logicalDate: changedDate.value.logicalDate }, base)
  active.editors.set(occurrenceDraft.key, () => occurrenceDraft)
  await active.submit(occurrenceDraft.key, { method: 'POST', path: `/task-definitions/${base.id}/occurrences`, body: { id: recovered.value.occurrenceId, logicalDate: changedDate.value.logicalDate, definitionVersion: base.serverVersion } })
  active.stop(); active = account(); await active.coordinator.catchUp(); await active.reload()
  assert.equal(creationStage(active.coordinator.snapshot().projection!, recovered.value), 'time')
  assert.equal(selectDateOnly(active.coordinator.snapshot().projection!, '2026-10-21').length, 1)
  assert.equal(selectCalendar(active.coordinator.snapshot().projection!, '2026-10-20T00:00:00Z', '2026-10-22T00:00:00Z').blocks.length, 0)
  assert.equal(commands.length, 2)
  const occurrence = active.coordinator.snapshot().projection!.occurrences.get(recovered.value.occurrenceId)!
  assert.equal(initialPlacementStart(occurrence, 'Europe/Moscow'), '')
  const localStart = `${occurrence.logicalDate}T10:00:00`
  const offset = resolveLocalTime(localStart, 'Europe/Moscow').utcOffset
  const placementDraft = editor(`placement:${occurrence.id}`, { localStart }, { occurrence, planState: plan })
  active.editors.set(placementDraft.key, () => placementDraft)
  await active.submit(placementDraft.key, { method: 'POST', path: `/occurrences/${occurrence.id}/placement`, version: occurrence.serverVersion, body: { action: 'place', localStart, timezone: 'Europe/Moscow', utcOffset: offset, baseScheduleVersion: plan.scheduleVersion, allowFixedChange: false } })
  assert.equal(creationStage(active.coordinator.snapshot().projection!, recovered.value), 'placed')
  assert.equal(selectDateOnly(active.coordinator.snapshot().projection!, '2026-10-21').length, 0)
  assert.equal(commands.length, 3)
  assert.equal(new Set(commands.map(command => command.opId)).size, 3)
  assert.equal(commands.filter(command => command.path === '/task-definitions').length, 1)
  assert.equal((await storage.drafts('anna')).find(isCreationRecord)?.value.logicalDate, '2026-10-21')
  active.stop()
})
test('continuation persistence is awaited; write failure stops the first send', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), committed = deferred<void>()
  const originalSave = storage.saveDraftCas.bind(storage), entered = deferred<void>()
  storage.saveDraftCas = async (draft, expected) => { entered.resolve(); await committed.promise; return originalSave(draft, expected) }
  let sends = 0
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
  const active = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async () => { sends++ })
  await coordinator.catchUp(); await active.reload()
  const continuation = prepareCreation('anna', crypto.randomUUID(), '2026-10-20')
  const first = (async () => { await active.saveDraftAndWait(continuation); await active.submit('new-definition', { method: 'POST', path: '/task-definitions', body: {} }) })()
  await entered.promise; assert.equal(sends, 0)
  storage.failWrites = true; committed.resolve()
  await assert.rejects(first, /quota/)
  assert.equal(sends, 0); active.stop()
})
test('lost definition ACK keeps its original pending and prevents a dependent command; continuation remains recoverable', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), intent = prepareCreation('anna', crypto.randomUUID(), '2026-10-20')
  const sent: string[] = []
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
  const active = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => { sent.push(command.opId); if (sent.length === 1) throw new NetworkError('lost ACK') })
  await coordinator.catchUp(); await active.reload(); await active.saveDraftAndWait(intent)
  await assert.rejects(active.submit('new-definition', { method: 'POST', path: '/task-definitions', body: { id: intent.value.definitionId } }))
  const original = await storage.getPending('anna')
  await assert.rejects(active.submit('create-occurrence', { method: 'POST', path: `/task-definitions/${intent.value.definitionId}/occurrences`, body: { id: intent.value.occurrenceId } }), /другая отправка/)
  assert.equal((await storage.getPending('anna'))?.opId, original?.opId)
  await active.retry()
  assert.deepEqual(sent, [original!.opId, original!.opId])
  assert.ok((await storage.drafts('anna')).some(record => record.draftId === intent.draftId))
  active.stop()
})
test('date-only selection uses logical date directly, excludes planned blocks and retains completed status', () => {
  const state = replaceItems(emptyProjection(plan, 'a', stream, 0), items(), plan, 'a')
  const incomplete = { ...occurrenceFixture(null, false), id: crypto.randomUUID(), logicalDate: '2026-10-20' }
  const completed = { ...occurrenceFixture(completionA, false), id: crypto.randomUUID(), logicalDate: '2026-10-20' }
  const planned = { ...occurrenceFixture(), id: crypto.randomUUID(), logicalDate: '2026-10-20' }
  const updated = replaceItems(state, [{ kind: 'occurrence', value: incomplete }, { kind: 'occurrence', value: completed }, { kind: 'occurrence', value: planned }], plan, 'b')
  const selected = selectDateOnly(updated, '2026-10-20')
  assert.equal(selected.length, 2)
  assert.deepEqual(new Set(selected.map(item => item.completionStatus)), new Set(['incomplete', 'completed']))
  assert.ok(selected.every(item => !item.calendarBlock && item.placementStatus === 'unplanned'))
  assert.equal(selectDateOnly(updated, '2026-10-19').length, 0)
  assert.equal(selectDateOnly(updated, '2026-10-21').length, 0)
})
test('initial datetime is durable before the first POST, survives ACK cleanup/reopen, and preserves an explicitly selected DST fold', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), start = resolvedCreationStart({ localStart: '2026-10-25T02:30', timezone: 'Europe/Berlin', utcOffset: '+01:00' })
  const intent = prepareCreation('anna', crypto.randomUUID(), '2026-10-25', undefined, start)
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap() : delta())
  let sent = false
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async () => { sent = true; assert.deepEqual((await storage.drafts('anna')).find(isCreationRecord)?.value.start, start) })
  await coordinator.catchUp(); await runtime.reload(); await runtime.saveDraftAndWait(intent)
  await runtime.submit('new-definition', { method: 'POST', path: '/task-definitions', body: { id: intent.value.definitionId } })
  assert.equal(sent, true); assert.equal(await storage.getPending('anna'), null)
  const recovered = (await storage.drafts('anna')).find(isCreationRecord)!
  const next = prepareCreation('anna', recovered.value.definitionId, recovered.value.logicalDate, recovered)
  assert.deepEqual(next.value.start, start); assert.equal(next.value.occurrenceId, recovered.value.occurrenceId)
  assert.equal(next.draftId, recovered.draftId)
  assert.throws(() => prepareCreation('anna', recovered.value.definitionId, '2026-10-26', recovered), /совпадать/)
  runtime.stop()
})
test('legacy continuation has no invented start; ordinary offsets resolve automatically but gap/fold require a valid explicit choice', () => {
  const legacy = prepareCreation('anna', crypto.randomUUID(), '2026-10-20')
  assert.equal(legacy.value.start, null)
  const old = structuredClone(legacy); delete (old.value as { start?: unknown }).start
  assert.equal(prepareCreation('anna', old.value.definitionId, old.value.logicalDate, old).value.start, null)
  assert.equal(resolvedCreationStart({ localStart: '2026-10-20T14:35', timezone: 'Europe/Moscow', utcOffset: '' }).utcOffset, '+03:00')
  assert.throws(() => resolvedCreationStart({ localStart: '2026-03-29T02:30', timezone: 'Europe/Berlin', utcOffset: '' }))
  assert.throws(() => resolvedCreationStart({ localStart: '2026-10-25T02:30', timezone: 'Europe/Berlin', utcOffset: '' }))
  assert.equal(resolvedCreationStart({ localStart: '2026-10-25T02:30', timezone: 'Europe/Berlin', utcOffset: '+02:00' }).utcOffset, '+02:00')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { SyncCoordinator, DELTA_LIMITS, DeltaLimitError } from '../src/sync/coordinator.ts'
import { bootstrapPage, changesPage, SyncSchemaError, validateWire } from '../src/sync/validation.ts'
import { recurrenceForDefinition, validateProjection, replaceItems, emptyProjection } from '../src/sync/projection.ts'
import { AccountRuntime } from '../src/sync/runtime.ts'
import { identityState } from '../src/state/session.ts'
import { ApiError } from '../src/api/client.ts'
import { bootstrap, deferred, delta, items, plan, stream } from './sync-fixture.ts'
import { occurrenceFixture } from './completion-fixture.ts'
import { rule, ruleChange } from './recurrence-fixture.ts'
import { MemoryStorage } from './storage-memory.ts'

test('s3 strict recurrence DTOs reject missing/unknown/prototype fields, old protocol and duplicate weekdays; UUID normalization preserves opaque versions', () => {
  const full = rule({ id: 'abcdefab-0000-4000-8000-000000000001', serverVersion: 'CaSe_V1' })
  const page = bootstrap({ items: [...items(), { kind: 'recurrence', value: full }] })
  assert.doesNotThrow(() => bootstrapPage(page))
  assert.throws(() => bootstrapPage({ ...page, protocol: 's1' }), SyncSchemaError)
  for (const key of Object.keys(full)) { const value = { ...full } as unknown as Record<string, unknown>; delete value[key]; assert.throws(() => validateWire(value, 'RecurrenceRuleU1'), SyncSchemaError, key) }
  for (const key of ['mode', 'resume', 'constructor', '__proto__']) { const value = structuredClone(full); Object.defineProperty(value, key, { value: true, enumerable: true }); assert.throws(() => validateWire(value, 'RecurrenceRuleU1'), SyncSchemaError) }
  assert.throws(() => validateWire({ ...full, daysOfWeek: ['monday', 'monday'] }, 'RecurrenceRuleU1'), SyncSchemaError)
  assert.throws(() => changesPage({ ...delta(), protocol: 's1' }), SyncSchemaError)
  const normalized = bootstrapPage({ ...page, items: [...items(), { kind: 'recurrence', value: { ...full, id: full.id.toUpperCase(), definitionId: full.definitionId.toUpperCase() } }] })
  const state = replaceItems(emptyProjection(plan, 'a', stream, 0), normalized.items, plan, 'a')
  assert.equal(recurrenceForDefinition(state, full.definitionId)?.id, full.id)
  assert.equal(recurrenceForDefinition(state, full.definitionId)?.serverVersion, 'CaSe_V1')
  assert.throws(() => validateProjection(replaceItems(state, [{ kind: 'recurrence', value: { ...full, id: crypto.randomUUID() } }], plan, 'b')), SyncSchemaError)
})
test('fixed-H pages sharing one opId stage rule plus occurrences atomically; no partial group/PlanState/cursor is published', async () => {
  const second = deferred<unknown>(), entered = deferred<void>(), firstChange = ruleChange(), generated = { ...occurrenceFixture(null, false), id: crypto.randomUUID(), logicalDate: '2026-10-19' }
  let count = 0
  const coordinator = new SyncCoordinator('anna', async path => {
    if (path.startsWith('/sync/bootstrap')) return bootstrap()
    count++
    if (count === 1) return delta({ nextCursor: 'old-tail' })
    if (count === 2) return delta({ changes: [{ ...firstChange, planState: { ...plan, planningInputRevision: 'group_end' } }], nextCursor: 'bound-H-page2', hasMore: true })
    entered.resolve(); return second.promise
  }, () => true)
  await coordinator.catchUp()
  const before = coordinator.snapshot().projection!, observed: boolean[] = []
  coordinator.subscribe(() => { const state = coordinator.snapshot().projection!; observed.push(state.recurrences.size > 0 && !state.occurrences.has(generated.id)) })
  const passing = coordinator.catchUp(); await entered.promise
  assert.equal(coordinator.snapshot().projection, before)
  second.resolve(delta({ nextCursor: 'unbound-after-H', changes: [{ id: crypto.randomUUID(), opId: firstChange.opId, item: { kind: 'occurrence', value: generated }, planState: { ...plan, planningInputRevision: 'group_end' } }] }))
  await passing
  assert.ok(observed.every(partial => !partial)); assert.equal(coordinator.snapshot().projection?.cursor, 'unbound-after-H')
  assert.equal(coordinator.snapshot().projection?.occurrences.has(generated.id), true)
  assert.equal(coordinator.snapshot().projection?.planState.planningInputRevision, 'group_end')
})
test('page/change/UTF8-byte/time caps discard staging, perform one bootstrap fallback then stop stale without an endless loop', async () => {
  assert.deepEqual(DELTA_LIMITS, { pages: 100, changes: 5000, bytes: 16777216, milliseconds: 30000 })
  for (const cap of ['pages', 'changes', 'bytes', 'milliseconds'] as const) {
    let clock = 0, boots = 0, reads = 0
    const coordinator = new SyncCoordinator('anna', async path => {
      if (path.startsWith('/sync/bootstrap')) { boots++; return bootstrap() }
      reads++
      if (reads === 1) return delta()
      if (cap === 'milliseconds') clock += 30001
      const change = ruleChange()
      return delta({ nextCursor: `bounded_${reads}`, hasMore: true, changes: cap === 'changes' ? [change, ruleChange({ id: crypto.randomUUID(), definitionId: crypto.randomUUID() })] : [change] })
    }, () => true, { clock: () => clock, limits: cap === 'milliseconds' ? {} : { [cap]: 1 } })
    await coordinator.catchUp()
    await assert.rejects(coordinator.catchUp(), DeltaLimitError)
    assert.equal(boots, 2, cap); assert.ok(reads <= 5, cap)
    assert.equal(coordinator.snapshot().status, 'stale'); assert.equal(coordinator.snapshot().projection?.recurrences.size, 0)
    assert.equal(coordinator.snapshot().projection?.occurrences.size, 1)
  }
})
test('terminal pages exactly on all caps are accepted and the unbound terminal cursor captures subsequent commits in a new pass', async () => {
  const change = ruleChange(), bytes = new TextEncoder().encode(JSON.stringify(change)).length
  let clock = 0, reads = 0
  const paths: string[] = []
  const coordinator = new SyncCoordinator('anna', async path => {
    paths.push(path)
    if (path.startsWith('/sync/bootstrap')) return bootstrap()
    reads++; clock += 30000
    return reads === 1 ? delta({ changes: [change], nextCursor: 'unbound-after-first-H' }) : delta({ changes: [ruleChange({ enabled: false })], nextCursor: 'unbound-after-next-H' })
  }, () => true, { clock: () => clock, limits: { pages: 1, changes: 1, bytes: Math.max(bytes, new TextEncoder().encode(JSON.stringify(ruleChange({ enabled: false }))).length) } })
  await coordinator.catchUp(); assert.equal(coordinator.snapshot().projection?.recurrences.size, 1)
  await coordinator.catchUp(); assert.match(paths[2]!, /cursor=unbound-after-first-H/)
  assert.equal(coordinator.snapshot().projection?.recurrences.values().next().value?.enabled, false)
})
test('401 or owner change mid-group never publishes staged private data', async () => {
  for (const auth of [true, false]) {
    let owner = true, reads = 0
    const coordinator = new SyncCoordinator('anna', async path => {
      if (path.startsWith('/sync/bootstrap')) return bootstrap()
      reads++
      if (reads === 1) return delta()
      if (reads === 2) return delta({ changes: [ruleChange()], nextCursor: 'group-page2', hasMore: true })
      if (auth) throw new ApiError({ status: 401, code: 'unauthorized' } as never)
      owner = false; return delta({ changes: [ruleChange()] })
    }, () => owner)
    await coordinator.catchUp(); const previous = coordinator.snapshot().projection
    await assert.rejects(coordinator.catchUp())
    assert.equal(coordinator.snapshot().projection, previous); assert.equal(previous?.recurrences.size, 0)
  }
})
test('invalid s1 cursor bootstraps once in the same stream without falsely resetting an old frozen pending', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(); let stale = false, boots = 0
  const coordinator = new SyncCoordinator('anna', async path => { if (path.startsWith('/sync/bootstrap')) { boots++; return bootstrap() }; if (stale) { stale = false; throw new ApiError({ status: 400, code: 'invalidCursor' } as never) }; return delta() })
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async () => { throw new Error('lost ACK') })
  await coordinator.catchUp(); await runtime.reload()
  await assert.rejects(runtime.submit('legacy', { method: 'POST', path: '/occurrences/old/completion', version: 'old_v1', body: {} }))
  const before = await storage.getPending('anna'); stale = true; await coordinator.catchUp(); await runtime.reconcile()
  assert.equal(boots, 2); assert.deepEqual(await storage.getPending('anna'), before); runtime.stop()
})
test('an ACK arriving during an old-H in-flight catch-up waits for a distinct post-ACK authoritative pass before releasing pending', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), old = deferred<unknown>(), entered = deferred<void>(), afterAck = deferred<unknown>(), newPass = deferred<void>()
  let reads = 0
  const coordinator = new SyncCoordinator('anna', async path => {
    if (path.startsWith('/sync/bootstrap')) return bootstrap()
    reads++
    if (reads === 1) return delta()
    if (reads === 2) { entered.resolve(); return old.promise }
    newPass.resolve(); return afterAck.promise
  })
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async () => undefined)
  await coordinator.catchUp(); await runtime.reload()
  const earlier = coordinator.catchUp(); await entered.promise
  const command = runtime.submit('stop', { method: 'POST', path: `/recurrence-rules/${rule().id}/stop`, version: 'rule_1', body: {} })
  // Wait on persisted ACK, without relying on a UI scheduling delay.
  const originalTransition = storage.transition.bind(storage), acked = deferred<void>()
  storage.transition = async (expected, patch, clean) => { const result = await originalTransition(expected, patch, clean); if (patch?.status === 'acknowledgedRefresh') acked.resolve(); return result }
  await acked.promise
  old.resolve(delta({ nextCursor: 'old-H-terminal' })); await earlier; await newPass.promise
  assert.equal((await storage.getPending('anna'))?.status, 'acknowledgedRefresh')
  afterAck.resolve(delta({ changes: [ruleChange({ enabled: false })], nextCursor: 'post-ACK-terminal' }))
  assert.equal((await command).success, true); assert.equal(await storage.getPending('anna'), null)
  assert.equal(coordinator.snapshot().projection?.recurrences.get(rule().id)?.enabled, false); runtime.stop()
})
test('the actual default boundary accepts 100 terminal pages and 5000 changes in one atomic publication', async () => {
  let pages = 0, partial = false
  const coordinator = new SyncCoordinator('anna', async path => {
    if (path.startsWith('/sync/bootstrap')) return bootstrap()
    pages++
    return delta({ hasMore: pages < 100, nextCursor: pages < 100 ? `bound_${pages}` : 'unbound_terminal', changes: Array.from({ length: 50 }, (_, index) => ruleChange({ serverVersion: `worker_${(pages - 1) * 50 + index + 1}` })) })
  }, () => true)
  coordinator.subscribe(() => { if (coordinator.snapshot().projection?.recurrences.size && pages < 100) partial = true })
  await coordinator.catchUp()
  assert.equal(pages, 100); assert.equal(partial, false)
  assert.equal(coordinator.snapshot().projection?.recurrences.get(rule().id)?.serverVersion, 'worker_5000')
  assert.equal(coordinator.snapshot().projection?.cursor, 'unbound_terminal')
})
test('actual 16MiB UTF8 overflow is detected below page/change limits, discarded, and only one bootstrap fallback is attempted', async () => {
  let boots = 0, reads = 0
  const original = items()[1]!
  if (original.kind !== 'definition') throw new Error('fixture')
  const large = { ...original.value, description: 'я'.repeat(4000) }
  const coordinator = new SyncCoordinator('anna', async path => {
    if (path.startsWith('/sync/bootstrap')) { boots++; return bootstrap() }
    reads++
    return delta({ hasMore: true, nextCursor: `bound_${reads}`, changes: Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), opId: crypto.randomUUID(), item: { kind: 'definition' as const, value: large }, planState: plan })) })
  }, () => true)
  await assert.rejects(coordinator.catchUp(), DeltaLimitError)
  assert.equal(boots, 2); assert.ok(reads < 100)
  assert.equal(coordinator.snapshot().status, 'stale'); assert.equal(coordinator.snapshot().projection?.definitions.get(large.id)?.description, '')
})
test('a hung network page reaches its monotonic generation deadline; late replies cannot publish discarded staging', async () => {
  const late = deferred<unknown>(); let boots = 0
  const coordinator = new SyncCoordinator('anna', async path => { if (path.startsWith('/sync/bootstrap')) { boots++; return bootstrap() }; return late.promise }, () => true, { limits: { milliseconds: 15 } })
  await assert.rejects(coordinator.catchUp(), DeltaLimitError)
  const previous = coordinator.snapshot().projection
  assert.equal(boots, 2); assert.equal(coordinator.snapshot().status, 'stale')
  late.resolve(delta({ changes: [ruleChange()] })); await Promise.resolve(); await Promise.resolve()
  assert.equal(coordinator.snapshot().projection, previous); assert.equal(previous?.recurrences.size, 0)
})

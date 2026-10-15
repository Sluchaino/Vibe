import test from 'node:test'
import assert from 'node:assert/strict'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { bootstrapPage, changesPage, SyncSchemaError } from '../src/sync/validation.ts'
import { emptyProjection, replaceItems, selectCalendar, selectOccurrences, pageItems, validateProjection } from '../src/sync/projection.ts'
import { ApiError } from '../src/api/client.ts'
import { bootstrap, deferred, delta, items, plan, stream } from './sync-fixture.ts'
import { completionA, occurrenceFixture } from './completion-fixture.ts'
import { calendarRange } from '../src/lib/time.ts'
import { wireSchemas } from '../src/sync/wire-schema.ts'
import { validateWire } from '../src/sync/validation.ts'
import { readFileSync } from 'node:fs'

test('bootstrap stages all pages and never publishes a partial account', async () => {
  const second = deferred<unknown>(), entered = deferred<void>()
  let calls = 0
  const coordinator = new SyncCoordinator('anna', async () => {
    calls++
    if (calls === 1) return bootstrap({ items: items().slice(0, 2), nextPageCursor: 'page2' })
    if (calls === 2) { entered.resolve(); return second.promise }
    return delta()
  }, () => true)
  const loading = coordinator.catchUp(); await entered.promise
  assert.equal(coordinator.snapshot().projection, null)
  second.resolve(bootstrap({ items: items().slice(2) })); await loading
  assert.equal(coordinator.snapshot().projection?.occurrences.size, 1)
  assert.equal(coordinator.snapshot().projection?.cursor, 'tail')
})
test('mixed snapshot page and unknown nested fields stop without publishing or advancing cursor', async () => {
  let calls = 0
  const coordinator = new SyncCoordinator('anna', async () => ++calls === 1 ? bootstrap({ items: items().slice(0, 2), nextPageCursor: 'p2' }) : bootstrap({ snapshotId: '10000000-0000-4000-8000-000000000099', items: items().slice(2) }), () => true)
  await assert.rejects(coordinator.catchUp(), SyncSchemaError)
  assert.equal(coordinator.snapshot().projection, null)
  assert.equal(coordinator.snapshot().status, 'stopped')
  const page = bootstrap(); (page.items[2]!.value as unknown as Record<string, unknown>).futureRequired = true
  assert.throws(() => bootstrapPage(page), SyncSchemaError)
  assert.throws(() => bootstrapPage({ ...bootstrap(), protocol: 's2' }), SyncSchemaError)
  const missing = bootstrap(); delete (missing.items[2]!.value as unknown as Record<string, unknown>).completionStatus
  assert.throws(() => bootstrapPage(missing), SyncSchemaError)
  assert.throws(() => changesPage({ ...delta(), changes: [{ id: stream, opId: stream, item: { kind: 'newThing', value: {} }, planState: plan }] }), SyncSchemaError)
})
test('ACK barrier finishes old bounded pass then starts a new tail after ACK', async () => {
  const old = deferred<unknown>(), entered = deferred<void>()
  let reads = 0
  const urls: string[] = []
  const coordinator = new SyncCoordinator('anna', async path => {
    urls.push(path); reads++
    if (reads === 1) return bootstrap()
    if (reads === 2) return delta({ nextCursor: 'initial-tail' })
    if (reads === 3) { entered.resolve(); return old.promise }
    if (reads === 4) return delta({ nextCursor: 'old-tail' })
    return delta({ nextCursor: 'after-ack-tail', changes: [{ id: '10000000-0000-4000-8000-000000000008', opId: stream, item: { kind: 'occurrence', value: occurrenceFixture(completionA) }, planState: { ...plan, planningInputRevision: 'input_after' } }] })
  }, () => true)
  await coordinator.catchUp()
  const oldPass = coordinator.catchUp(); await entered.promise
  const ackBarrier = coordinator.catchUp()
  old.resolve(delta({ nextCursor: 'old-bound', hasMore: true, changes: [{ id: '10000000-0000-4000-8000-000000000007', opId: stream, item: items()[1]!, planState: plan }] }))
  await oldPass; await ackBarrier
  assert.match(urls[3]!, /cursor=old-bound/)
  assert.match(urls[4]!, /cursor=old-tail/)
  assert.equal(coordinator.snapshot().projection?.cursor, 'after-ack-tail')
  assert.equal(coordinator.snapshot().projection?.occurrences.values().next().value?.completionStatus, 'completed')
})
test('late account response and stopped generation cannot publish private state', async () => {
  let owner = true
  const late = deferred<unknown>()
  const coordinator = new SyncCoordinator('anna', () => late.promise, () => owner)
  const read = coordinator.catchUp(); await Promise.resolve(); owner = false; late.resolve(bootstrap())
  await assert.rejects(read)
  assert.equal(coordinator.snapshot().projection, null)
})
test('retention reset bootstraps without combining old and new projections', async () => {
  let calls = 0
  const coordinator = new SyncCoordinator('anna', async () => {
    calls++
    if (calls === 1) return bootstrap()
    if (calls === 2) return delta()
    if (calls === 3) throw new ApiError({ status: 410, code: 'syncResetRequired' } as never)
    if (calls === 4) return bootstrap({ streamId: '10000000-0000-4000-8000-000000000099' })
    return delta({ streamId: '10000000-0000-4000-8000-000000000099' })
  }, () => true)
  await coordinator.catchUp(); await coordinator.catchUp()
  assert.equal(coordinator.snapshot().projection?.streamId, '10000000-0000-4000-8000-000000000099')
})
test('full replacement removes old block/completion and all selectors share current metadata', () => {
  const base = replaceItems(emptyProjection(plan, 'a', stream, 0), items(), plan, 'a')
  const complete = replaceItems(base, [{ kind: 'occurrence', value: occurrenceFixture(completionA) }], plan, 'b')
  assert.equal(selectOccurrences(complete, 'incomplete', undefined, true).length, 0)
  const next = replaceItems(complete, [{ kind: 'occurrence', value: occurrenceFixture(null, false) }], plan, 'c')
  validateProjection(next)
  assert.equal(selectOccurrences(next, 'incomplete', undefined, true).length, 1)
  assert.equal(selectCalendar(next, '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z').blocks.length, 0)
  assert.equal(complete.occurrences.values().next().value?.completion?.id, completionA)
})
test('filter before pagination and zone change recompute DST range without changing elapsed block', () => {
  const base = replaceItems(emptyProjection(plan, 'a', stream, 0), items(), plan, 'a')
  const occurrences = Array.from({ length: 120 }, (_, i) => ({ ...occurrenceFixture(i < 70 ? completionA : null, false), id: `80000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` }))
  const state = { ...base, occurrences: new Map(occurrences.map(item => [item.id, item])) }
  assert.equal(pageItems(selectOccurrences(state, 'incomplete'), 50).items.length, 50)
  assert.equal(pageItems(selectOccurrences(state, 'completed'), 50).hasMore, true)
  const berlin = calendarRange('2026-10-25', 'week', 'Europe/Berlin')
  const utc = calendarRange('2026-10-25', 'week', 'UTC')
  assert.equal((Date.parse(berlin.to) - Date.parse(berlin.from)) / 3600000, 169)
  assert.equal((Date.parse(utc.to) - Date.parse(utc.from)) / 3600000, 168)
  assert.equal(selectCalendar(base, berlin.from, berlin.to).blocks[0]?.startInstant, occurrenceFixture().calendarBlock?.startInstant)
  assert.equal(calendarRange('0001-01-01', 'day', 'UTC').from, '0001-01-01T00:00:00Z')
  assert.throws(() => calendarRange('9999-12-31', 'day', 'UTC'), /границ/)
})
test('uppercase C1 UUID references normalize only received projection; bootstrap/delta/selectors stay coherent', async () => {
  const page = bootstrap()
  const settings = page.items.find(item => item.kind === 'settings')!
  const definition = page.items.find(item => item.kind === 'definition')!
  const occurrence = page.items.find(item => item.kind === 'occurrence')!
  const categoryId = 'abcdefab-0000-4000-8000-000000000001'
  page.items.splice(1, 0, { kind: 'category', value: { id: categoryId, name: 'Категория', serverVersion: 'CaSe_V1' } })
  if (settings.kind === 'settings') settings.value.place!.id = 'abcdefab-0000-4000-8000-000000000002'
  if (definition.kind === 'definition') { definition.value.categoryId = categoryId.toUpperCase(); definition.value.placeId = 'ABCDEFAB-0000-4000-8000-000000000002'; definition.value.serverVersion = 'CaSe_V1' }
  if (occurrence.kind === 'occurrence') occurrence.value.constraintsSnapshot.placeId = 'ABCDEFAB-0000-4000-8000-000000000002'
  let call = 0
  const coordinator = new SyncCoordinator('anna', async () => ++call === 1 ? page : delta({ changes: [{ id: stream, opId: stream, item: definition, planState: plan }] }), () => true)
  await coordinator.catchUp()
  const projection = coordinator.snapshot().projection!
  assert.equal(projection.categories.has(projection.definitions.values().next().value!.categoryId!), true)
  assert.equal(projection.definitions.values().next().value?.serverVersion, 'CaSe_V1')
  assert.equal(selectOccurrences(projection, 'all').length, 1)
  assert.equal(selectCalendar(projection, '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z').definitions[0]?.placeId, 'abcdefab-0000-4000-8000-000000000002')
  if (definition.kind === 'definition') assert.equal(definition.value.categoryId, categoryId.toUpperCase()) // Source object was not mutated.
})
test('empty bootstrap continuation is rejected rather than looping opaque cursors', async () => {
  const coordinator = new SyncCoordinator('anna', async () => bootstrap({ items: [], nextPageCursor: 'no-progress' }), () => true)
  await assert.rejects(coordinator.catchUp(), SyncSchemaError)
  assert.equal(coordinator.snapshot().projection, null)
})
test('closed DTOs reject prototype-named unknown fields and inherited required fields', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const page = bootstrap() as unknown as Record<string, unknown>
    Object.defineProperty(page, key, { value: 'unknown field', enumerable: true })
    assert.throws(() => bootstrapPage(page), SyncSchemaError, `root ${key}`)
    const nested = structuredClone(bootstrap())
    Object.defineProperty(nested.planState, key, { value: {}, enumerable: true })
    assert.throws(() => bootstrapPage(nested), SyncSchemaError, `nested ${key}`)
  }
  const inherited = Object.assign(Object.create({ planningInputRevision: 'input_1' }) as Record<string, unknown>, { scheduleVersion: 'schedule_1' })
  assert.throws(() => validateWire(inherited, 'PlanState'), SyncSchemaError)
  assert.doesNotThrow(() => bootstrapPage(bootstrap()))
})
test('frozen runtime schema exactly matches transitive live schemas and validates their examples', () => {
  const contract = JSON.parse(readFileSync(new URL('../../contracts/d1.openapi.json', import.meta.url), 'utf8')) as { components: { schemas: Record<string, Record<string, unknown>> } }
  const selected: Record<string, unknown> = {}
  function collect(name: string) {
    if (selected[name]) return
    const schema = contract.components.schemas[name]!
    selected[name] = schema
    for (const match of JSON.stringify(schema).matchAll(/#\/components\/schemas\/([A-Za-z0-9]+)/g)) collect(match[1]!)
  }
  function stripped(node: unknown, propertyNames = false): unknown {
    if (Array.isArray(node)) return node.map(value => stripped(value))
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).filter(([key]) => propertyNames || !['description', 'examples', 'example', 'title', 'discriminator', 'default'].includes(key)).map(([key, value]) => [key, stripped(value, key === 'properties')]))
    return node
  }
  collect('BootstrapPage'); collect('ChangesPage')
  assert.deepEqual(wireSchemas, stripped(selected, true))
  for (const [name, schema] of Object.entries(selected)) {
    for (const example of (schema as { examples?: unknown[] }).examples ?? []) assert.doesNotThrow(() => validateWire(example, name), `${name} example must match frozen wire`)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { pageTaskDays, selectTaskDays, taskDateRange, taskToday } from '../src/lib/task-period.ts'
import { completionCommand, completionIntent } from '../src/lib/completion.ts'
import { emptyProjection, replaceItems, type Projection } from '../src/sync/projection.ts'
import { SyncCoordinator } from '../src/sync/coordinator.ts'
import { AccountRuntime } from '../src/sync/runtime.ts'
import { identityState } from '../src/state/session.ts'
import { NetworkError } from '../src/api/client.ts'
import type { SyncChange, TaskOccurrence } from '../src/api/types.ts'
import { bootstrap, delta, items, plan, stream } from './sync-fixture.ts'
import { completionA, occurrenceFixture } from './completion-fixture.ts'
import { MemoryStorage } from './storage-memory.ts'

function occurrence(date: string, completed = false, planned = false): TaskOccurrence {
  const id = crypto.randomUUID(), original = occurrenceFixture(completed ? completionA : null, planned)
  return { ...original, id, logicalDate: date, calendarBlock: original.calendarBlock ? { ...original.calendarBlock, id: crypto.randomUUID(), occurrenceId: id } : null, completion: original.completion ? { ...original.completion, id: crypto.randomUUID(), occurrenceId: id } : null }
}
function state(occurrences: TaskOccurrence[]): Projection {
  return replaceItems(emptyProjection(plan, 'a', stream, 1), [...items().slice(0, 2), ...occurrences.map(value => ({ kind: 'occurrence' as const, value }))], plan, 'b')
}
function dates(segments: ReturnType<typeof selectTaskDays>) { return segments.flatMap(segment => segment.days.map(day => day.date)) }
function rows(segments: ReturnType<typeof selectTaskDays>) { return segments.flatMap(segment => segment.days.flatMap(day => day.occurrences)) }
const custom = { from: '2026-10-01', to: '2026-10-31' }

test('period bounds include Monday through Sunday across month/year boundaries and exact leap/non-leap month ends', () => {
  assert.deepEqual(taskDateRange('today', '2026-10-17', custom), { from: '2026-10-17', to: '2026-10-17' })
  assert.deepEqual(taskDateRange('week', '2026-11-01', custom), { from: '2026-10-26', to: '2026-11-01' })
  assert.deepEqual(taskDateRange('week', '2026-12-31', custom), { from: '2026-12-28', to: '2027-01-03' })
  assert.deepEqual(taskDateRange('month', '2024-02-29', custom), { from: '2024-02-01', to: '2024-02-29' })
  assert.deepEqual(taskDateRange('month', '2025-02-28', custom), { from: '2025-02-01', to: '2025-02-28' })
  assert.deepEqual(taskDateRange('month', '2026-12-31', custom), { from: '2026-12-01', to: '2026-12-31' })
  assert.deepEqual(taskDateRange('all', '2026-10-17', custom), { from: null, to: null })
})
test('today follows settings IANA zone and rolls at actual midnight on 23h/25h DST days, without advancing by UTC+24h', () => {
  const instant = Date.parse('2026-10-17T00:30:00Z')
  assert.equal(taskToday('America/Los_Angeles', instant), '2026-10-16')
  assert.equal(taskToday('Europe/Moscow', instant), '2026-10-17')
  for (const [before, after, first, second] of [
    ['2026-03-29T21:59:59Z', '2026-03-29T22:00:00Z', '2026-03-29', '2026-03-30'],
    ['2026-10-25T22:59:59Z', '2026-10-25T23:00:00Z', '2026-10-25', '2026-10-26'],
  ]) {
    assert.equal(taskToday('Europe/Berlin', Date.parse(before!)), first)
    assert.equal(taskToday('Europe/Berlin', Date.parse(after!)), second)
  }
  const data = state([occurrence('2026-03-29'), occurrence('2026-03-30')])
  assert.deepEqual(dates(selectTaskDays(data, 'today', taskToday('Europe/Berlin', Date.parse('2026-03-29T21:59:59Z')), custom)), ['2026-03-29'])
  assert.deepEqual(dates(selectTaskDays(data, 'today', taskToday('Europe/Berlin', Date.parse('2026-03-29T22:00:00Z')), custom)), ['2026-03-30'])
})
test('custom civil dates are inclusive at both ends and use logicalDate, retaining date-only and completed occurrences', () => {
  const first = occurrence('2024-02-28'), middle = occurrence('2024-02-29', true), last = occurrence('2024-03-01', false, true)
  // The planned instant is deliberately October; filtering must use March's
  // logical date, never a block timestamp or an invented date-only block.
  const data = state([occurrence('2024-02-27'), last, middle, first, occurrence('2024-03-02')])
  const selected = selectTaskDays(data, 'custom', '2026-10-17', { from: '2024-02-28', to: '2024-03-01' })
  assert.deepEqual(dates(selected), ['2024-02-28', '2024-02-29', '2024-03-01'])
  assert.deepEqual(new Set(rows(selected).map(row => row.id)), new Set([first.id, middle.id, last.id]))
  assert.equal(rows(selected).find(row => row.id === middle.id)?.completionStatus, 'completed')
  assert.equal(rows(selected).find(row => row.id === first.id)?.calendarBlock, null)
})
test('invalid, empty, reversed and non-leap custom dates are rejected instead of silently normalizing or showing another period', () => {
  for (const range of [{ from: '', to: '2026-10-17' }, { from: '2026-2-01', to: '2026-10-17' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2025-02-29', to: '2025-03-01' }]) assert.throws(() => taskDateRange('custom', '2026-10-17', range), /действительные даты/)
  assert.throws(() => taskDateRange('custom', '2026-10-17', { from: '2026-10-20', to: '2026-10-19' }), /не раньше/)
  assert.deepEqual(taskDateRange('custom', '2026-10-17', { from: '2024-02-29', to: '2024-02-29' }), { from: '2024-02-29', to: '2024-02-29' })
})
test('current week shows today-to-end ascending, then start-to-yesterday ascending; all/custom remain chronological', () => {
  const data = state(['2026-10-25', '2026-10-19', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-18', '2026-10-26'].map(date => occurrence(date)))
  const week = selectTaskDays(data, 'week', '2026-10-21', custom)
  assert.deepEqual(week.map(segment => [segment.kind, segment.days.map(day => day.date)]), [
    ['upcoming', ['2026-10-21', '2026-10-22', '2026-10-25']], ['past', ['2026-10-19', '2026-10-20']],
  ])
  assert.deepEqual(dates(selectTaskDays(data, 'custom', '2026-10-21', { from: '2026-10-19', to: '2026-10-25' })), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-25'])
  assert.deepEqual(dates(selectTaskDays(data, 'all', '2026-10-21', custom)), ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-25', '2026-10-26'])
})
test('current month rolls both segments in their own ascending order and never includes adjacent months', () => {
  const data = state(['2026-10-31', '2026-10-02', '2026-09-30', '2026-10-20', '2026-10-16', '2026-11-01', '2026-10-01', '2026-10-17'].map(date => occurrence(date)))
  const selected = selectTaskDays(data, 'month', '2026-10-17', custom)
  assert.deepEqual(selected.map(segment => segment.days.map(day => day.date)), [['2026-10-17', '2026-10-20', '2026-10-31'], ['2026-10-01', '2026-10-02', '2026-10-16']])
  const nextDay = selectTaskDays(data, 'month', '2026-10-18', custom)
  assert.deepEqual(nextDay[0]?.days.map(day => day.date), ['2026-10-20', '2026-10-31'])
  assert.deepEqual(nextDay[1]?.days.map(day => day.date), ['2026-10-01', '2026-10-02', '2026-10-16', '2026-10-17'])
})
test('whole-day pagination retains a day with more than fifty tasks and exposes both future and past segments independently', () => {
  const source = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`).flatMap(date => Array.from({ length: date.endsWith('-16') ? 83 : 2 }, () => occurrence(date)))
  const selected = selectTaskDays(state(source), 'month', '2026-10-16', custom)
  const upcoming = pageTaskDays(selected[0]!.days, 7), past = pageTaskDays(selected[1]!.days, 7)
  assert.equal(upcoming.days[0]?.occurrences.length, 83)
  assert.equal(past.days[0]?.date, '2026-10-01')
  assert.equal(upcoming.hasMore, true); assert.equal(past.hasMore, true)
  const finished = selected.flatMap(segment => pageTaskDays(segment.days, 35).days.flatMap(day => day.occurrences))
  assert.equal(finished.length, source.length); assert.equal(new Set(finished.map(row => row.id)).size, source.length)
  assert.deepEqual(pageTaskDays(selected[0]!.days, 14).days.slice(0, 7), upcoming.days)
  assert.deepEqual(pageTaskDays(selected[1]!.days, 14).days.slice(0, 7), past.days)
})
test('completion status is filtered before day pagination; all is the default and planned/date-only completed tasks remain visible', () => {
  const done = occurrence('2026-10-17', true), plannedDone = occurrence('2026-10-18', true, true), open = occurrence('2026-10-19')
  const data = state([done, plannedDone, open])
  assert.equal(rows(selectTaskDays(data, 'all', '2026-10-17', custom)).length, 3)
  const filtered = selectTaskDays(data, 'all', '2026-10-17', custom, 'incomplete')
  assert.deepEqual(pageTaskDays(filtered[0]!.days, 1).days[0]?.occurrences.map(row => row.id), [open.id])
  assert.deepEqual(rows(selectTaskDays(data, 'all', '2026-10-17', custom, 'completed')).map(row => row.id), [done.id, plannedDone.id])
})
test('Tasks selection follows confirmed C1 complete/reopen, uses fresh versions and selected completion target, and ignores ACK bodies', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), changes: SyncChange[] = []
  let server = { ...occurrenceFixture(), logicalDate: '2026-10-17' }, sends = 0
  const coordinator = new SyncCoordinator('anna', async path => path.startsWith('/sync/bootstrap') ? bootstrap({ items: [...items().slice(0, 2), { kind: 'occurrence', value: server }] }) : delta({ changes: changes.splice(0) }))
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async (command, guard) => {
    guard(); sends++
    assert.equal(command.version, server.serverVersion)
    if (sends === 1) server = { ...occurrenceFixture(completionA), logicalDate: '2026-10-17' }
    else { assert.equal(command.body.completionId, completionA); server = { ...occurrenceFixture(), logicalDate: '2026-10-17', serverVersion: 'occ_v3' } }
    changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'occurrence', value: structuredClone(server) }, planState: plan })
    return { obsoleteAck: { ...occurrenceFixture(), completionStatus: 'incomplete' } }
  })
  await coordinator.catchUp(); await runtime.reload()
  const selected = () => rows(selectTaskDays(coordinator.snapshot().projection!, 'today', '2026-10-17', custom))[0]!
  const block = structuredClone(selected().calendarBlock)
  assert.equal(completionIntent(selected()).action, 'complete')
  await runtime.submit(`completion:${server.id}`, completionCommand(selected(), completionIntent(selected())))
  assert.equal(selected().completionStatus, 'completed'); assert.deepEqual(selected().calendarBlock, block)
  assert.equal(completionIntent(selected()).action, 'reopen')
  await runtime.submit(`completion:${server.id}`, completionCommand(selected(), completionIntent(selected())))
  assert.equal(selected().completionStatus, 'incomplete'); assert.equal(selected().serverVersion, 'occ_v3')
  assert.equal(sends, 2); assert.equal(await storage.getPending('anna'), null); runtime.stop()
})
test('failed post-ACK refresh keeps the old confirmed Tasks selection and blocks new commands until fresh authoritative pull', async () => {
  identityState.activate('anna')
  const storage = new MemoryStorage(), changes: SyncChange[] = []
  let fail = false, sends = 0
  const coordinator = new SyncCoordinator('anna', async path => { if (fail) throw new NetworkError('pull failed'); return path.startsWith('/sync/bootstrap') ? bootstrap({ items: [...items().slice(0, 2), { kind: 'occurrence', value: { ...occurrenceFixture(), logicalDate: '2026-10-17' } }] }) : delta({ changes: changes.splice(0) }) })
  const runtime = new AccountRuntime('anna', Promise.resolve(storage), coordinator, async command => { sends++; changes.push({ id: crypto.randomUUID(), opId: command.opId, item: { kind: 'occurrence', value: { ...occurrenceFixture(completionA), logicalDate: '2026-10-17' } }, planState: plan }); fail = true })
  await coordinator.catchUp(); await runtime.reload()
  const selected = () => rows(selectTaskDays(coordinator.snapshot().projection!, 'today', '2026-10-17', custom))[0]!
  await assert.rejects(runtime.submit(`completion:${selected().id}`, completionCommand(selected(), completionIntent(selected()))), /pull failed/)
  assert.equal(selected().completionStatus, 'incomplete'); assert.equal(coordinator.snapshot().status, 'stale')
  assert.equal((await storage.getPending('anna'))?.status, 'acknowledgedRefresh')
  await assert.rejects(runtime.submit(`completion:${selected().id}`, completionCommand(selected(), completionIntent(selected()))), /обновления/)
  fail = false; await coordinator.catchUp(); await runtime.retry()
  assert.equal(selected().completionStatus, 'completed'); assert.equal(sends, 1); runtime.stop()
})

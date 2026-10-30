import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptUnifiedDraft, freshUnifiedDraft, scheduleInput } from '../src/lib/unified-task.ts'
import { emptyTiming, legacyTiming, timeIntent, timingDraft, timingPreview, workOrigin } from '../src/lib/task-timing.ts'
import { editableBase, sameData } from '../src/lib/durable-draft.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { completionCommand, completionIntent, hasCurrentCompletion } from '../src/lib/completion.ts'
import { emptyProjection, replaceItems, selectCalendar, selectDateOnly, validateProjection } from '../src/sync/projection.ts'
import { selectTaskDays } from '../src/lib/task-period.ts'
import { bootstrapPage, changesPage, SyncSchemaError, validateWire } from '../src/sync/validation.ts'
import { occurrenceFixture, completionA } from './completion-fixture.ts'
import { bootstrap, delta, items, plan, stream } from './sync-fixture.ts'
import { rule } from './recurrence-fixture.ts'
import { taskTimeSummary } from '../src/lib/task-time-summary.ts'

test('fresh unified initializer has no date, hours or volume; changing repetition remains one editable draft value', () => {
  const value = freshUnifiedDraft('Europe/Moscow', 'place', '2026-10-19')
  assert.equal(value.timing.logicalDate, ''); assert.equal(value.timing.startTime, ''); assert.equal(value.timing.endTime, ''); assert.equal(value.minutes, '')
  assert.equal(value.repeat, 'none'); assert.equal(value.anchorDate, '2026-10-19')
  const changed = { ...value, repeat: 'interval' as const, intervalDays: '3' }
  assert.equal(changed.id, value.id); assert.equal(changed.occurrenceId, value.occurrenceId); assert.equal(changed.ruleId, value.ruleId)
  assert.equal(timeIntent(value.timing), null); assert.equal(workOrigin('', null), 'unspecified')
  assert.deepEqual(taskTimeSummary(value), { timing: 'Дата и время не заданы', conditions: 'Без повторения' })
  assert.match(taskTimeSummary(changed).conditions, /Через каждые 3 дн. от 19.10.2026/)
})

test('legacy 09/60/date and weekly choices are retained; both fold offsets become the exact earlier/later preference without editing frozen payloads', () => {
  for (const [offset, preference] of [['+02:00', 'earlier'], ['+01:00', 'later']] as const) {
    const old = { id: 'definition', title: 'Старая', minutes: '60', firstLocalStart: '2026-10-25T02:30', firstTimezone: 'Europe/Berlin', firstUtcOffset: offset }
    const before = JSON.stringify(old)
    const converted = adaptUnifiedDraft(old, 'UTC', 'place', '2026-10-19')
    assert.equal(converted.id, old.id); assert.equal(converted.minutes, '60'); assert.equal(converted.workOrigin, 'manual')
    assert.equal(converted.timing.startDisambiguation, preference); assert.equal(converted.timing.logicalDate, '2026-10-25')
    assert.equal(JSON.stringify(old), before)
  }
  const recurring = adaptUnifiedDraft({ minutes: '60', firstLocalStart: '2026-10-25T09:00', recurrence: { id: 'rule', timezone: 'Europe/Berlin', daysOfWeek: ['sunday'], startDate: '2026-10-25', endDate: '2026-12-20' } }, 'UTC', 'place', '2026-10-19')
  assert.equal(recurring.timing.startTime, '09:00'); assert.equal(recurring.repeat, 'selected'); assert.equal(recurring.endDate, '2026-12-20'); assert.deepEqual(recurring.daysOfWeek, ['sunday'])
  assert.equal(legacyTiming({ firstOccurrenceDate: '2026-10-21' }, 'UTC').startTime, '')
})

test('null, date-only and a single unknown boundary retain distinct U1 intent without inventing a block or volume', () => {
  const value = emptyTiming('Europe/Moscow')
  assert.equal(timeIntent(value), null)
  value.logicalDate = '2026-10-21'
  assert.equal(timeIntent(value), null)
  value.endTime = '18:30'
  const intent = timeIntent(value)!
  assert.deepEqual(intent, { timezone: 'Europe/Moscow', startLocalTime: null, endLocalTime: '18:30', endDayOffset: 0, startDisambiguation: null, endDisambiguation: null })
  assert.deepEqual(timingPreview(value.logicalDate, intent, null), { resolved: null, minutes: null, issue: null })
  assert.equal(workOrigin('', intent), 'unspecified')
  assert.throws(() => timeIntent({ ...value, logicalDate: '' }), /дату/)
  assert.throws(() => timeIntent({ ...value, endDayOffset: '' }), /число дней/)
  const summary = taskTimeSummary({ ...freshUnifiedDraft('Europe/Moscow', 'place', '2026-10-19'), timing: { ...value, endDayOffset: '2' }, minutes: '90' })
  assert.match(summary.timing, /конец 18:30 \(\+2 дн.\)/)
  assert.doesNotMatch(summary.timing, /начало|09:00/)
  assert.match(summary.conditions, /полный объём 90 мин/)
})

test('full automatic interval uses elapsed minutes across Berlin 23/25h and Lord Howe half-hour changes; explicit manual volume is never replaced', () => {
  for (const [date, zone, expected] of [['2026-03-29', 'Europe/Berlin', 1380], ['2026-10-25', 'Europe/Berlin', 1500], ['2026-04-05', 'Australia/Lord_Howe', 1470], ['2026-10-04', 'Australia/Lord_Howe', 1410]] as const) {
    const intent = timeIntent({ ...emptyTiming(zone), logicalDate: date, startTime: '00:00', endTime: '00:00', endDayOffset: '1' })!
    assert.equal(workOrigin('', intent), 'interval')
    assert.equal(timingPreview(date, intent, null).minutes, expected)
    assert.equal(workOrigin(String(expected), intent), 'manual')
    assert.equal(timingPreview(date, intent, 1440).issue, 'workMismatch')
  }
})

test('manual start+N and end−N preview neighbouring dates; no implicit overnight and all three entries must agree', () => {
  const start = timeIntent({ ...emptyTiming('Europe/Moscow'), logicalDate: '2026-10-21', startTime: '23:30' })!
  assert.equal(timingPreview('2026-10-21', start, 120).resolved?.endInstant, '2026-10-21T22:30:00Z')
  const end = { ...start, startLocalTime: null, endLocalTime: '00:30' }
  assert.equal(timingPreview('2026-10-21', end, 90).resolved?.startInstant, '2026-10-20T20:00:00Z')
  const inverted = { ...start, endLocalTime: '01:30' }
  assert.equal(timingPreview('2026-10-21', inverted, null).issue, 'workMismatch')
  assert.equal(timingPreview('2026-10-21', { ...inverted, endDayOffset: 1 }, null).minutes, 120)
  assert.equal(timingPreview('2026-10-21', { ...inverted, endDayOffset: 1 }, 60).issue, 'workMismatch')
})

test('gap/fold are visible unresolved intentions; selected earlier/later preserves real distinct instants', () => {
  const timing = { ...emptyTiming('Europe/Berlin'), logicalDate: '2026-03-29', startTime: '02:30', endTime: '04:00' }
  assert.equal(timingPreview(timing.logicalDate, timeIntent(timing), null).issue, 'invalidLocalTime')
  timing.logicalDate = '2026-10-25'
  assert.equal(timingPreview(timing.logicalDate, timeIntent(timing), null).issue, 'ambiguousLocalTime')
  const early = timingPreview(timing.logicalDate, timeIntent({ ...timing, startDisambiguation: 'earlier' }), null)
  const late = timingPreview(timing.logicalDate, timeIntent({ ...timing, startDisambiguation: 'later' }), null)
  assert.equal(early.minutes, 150); assert.equal(late.minutes, 90)
  assert.equal(timingDraft(timing.logicalDate, timeIntent({ ...timing, startDisambiguation: 'later' }), 'UTC').startDisambiguation, 'later')
})

test('DateOnly/year limits include the derived local year, not only UTC; overflow is an issue and never a wrapped date', () => {
  const max = timeIntent({ ...emptyTiming('Europe/Moscow'), logicalDate: '9999-12-31', startTime: '23:00' })!
  assert.equal(timingPreview('9999-12-31', max, 120).issue, 'outOfRange')
  const min = { ...max, timezone: 'Etc/GMT+12', startLocalTime: null, endLocalTime: '00:30' }
  assert.equal(timingPreview('0001-01-01', min, 120).issue, 'outOfRange')
  for (const date of ['0000-01-01', '2025-02-29']) assert.throws(() => timeIntent({ ...emptyTiming('UTC'), logicalDate: date }))
  assert.throws(() => timeIntent({ ...emptyTiming('UTC'), logicalDate: '9999-12-31', endTime: '01:00', endDayOffset: '1' }))
})

test('everyN uses a frozen visible anchor and inclusive end, with no weekday fields; weekly remains a separate closed branch', () => {
  const schedule = { id: stream, timezone: 'Europe/Berlin', startDate: '2024-02-29', endDate: '2026-10-21', intervalDays: '3', daysOfWeek: ['monday'] as const, pattern: 'interval' as const }
  const input = scheduleInput({ ...schedule, daysOfWeek: [...schedule.daysOfWeek] }, null)
  assert.equal(input.pattern, 'interval'); assert.equal('anchorDate' in input && input.anchorDate, '2024-02-29')
  assert.equal(Object.hasOwn(input, 'daysOfWeek'), false)
  assert.doesNotThrow(() => validateWire({ ...input, opId: stream, definitionVersion: 'def_1' }, 'CreateRecurrenceRuleRequestU1'))
  for (const intervalDays of ['0', '-1', '1.5', '2147483648']) assert.throws(() => scheduleInput({ ...schedule, daysOfWeek: [], intervalDays }, null))
  assert.throws(() => scheduleInput({ ...schedule, daysOfWeek: [], endDate: '2024-02-28' }, null))
})

test('s3 requires explicit U1 fields and rejects legacy live shapes; input interval null differs from read interval N', () => {
  const page = bootstrap()
  assert.doesNotThrow(() => bootstrapPage(page))
  assert.throws(() => bootstrapPage({ ...page, protocol: 's2' }), SyncSchemaError)
  const old = structuredClone(page); delete (old.items[1]!.value as unknown as Record<string, unknown>).workOrigin
  assert.throws(() => bootstrapPage(old), SyncSchemaError)
  const snapshot = { ...occurrenceFixture().constraintsSnapshot, workOrigin: 'interval' }
  assert.doesNotThrow(() => validateWire(snapshot, 'ConstraintsSnapshotU1'))
  assert.throws(() => validateWire(snapshot, 'ConstraintsInputU1'), SyncSchemaError)
  assert.doesNotThrow(() => validateWire({ ...snapshot, durationPolicy: null }, 'ConstraintsInputU1'))
  assert.throws(() => validateWire({ ...timeIntent({ ...emptyTiming('UTC'), logicalDate: '2026-10-21', startTime: '09:00' }), endLocalTime: null, endDayOffset: 1 }, 'TimeIntent'), SyncSchemaError)
  const intervalRule = { ...rule(), pattern: 'interval', intervalDays: 3, anchorDate: '2026-10-19' } as Record<string, unknown>
  delete intervalRule.daysOfWeek
  assert.doesNotThrow(() => changesPage(delta({ changes: [{ id: stream, opId: stream, item: { kind: 'recurrence', value: intervalRule } as never, planState: plan }] })))
})

test('undated tasks appear in All and Undated only, retaining unknown volume/completion; date-only remains a real day card with no fake block', () => {
  const occurrence = { ...occurrenceFixture(null, false), logicalDate: null, constraintsSnapshot: { ...occurrenceFixture().constraintsSnapshot, workOrigin: 'unspecified' as const, durationPolicy: null }, remainingWorkMinutes: null }
  const state = replaceItems(emptyProjection(plan, 'a', stream, 0), [...items().slice(0, 2), { kind: 'occurrence', value: occurrence }], plan, 'b')
  validateProjection(state)
  for (const period of ['today', 'week', 'month', 'custom'] as const) assert.equal(selectTaskDays(state, period, '2026-10-25', { from: '2026-10-01', to: '2026-10-31' }).flatMap(segment => segment.days).length, 0)
  for (const period of ['all', 'undated'] as const) assert.equal(selectTaskDays(state, period, '2026-10-25', { from: '', to: '' })[0]!.days[0]!.date, '')
  assert.equal(selectDateOnly(state, '2026-10-25').length, 0); assert.equal(selectCalendar(state, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z').blocks.length, 0)
  const dated = replaceItems(state, [{ kind: 'occurrence', value: { ...occurrence, logicalDate: '2026-10-25' } }], plan, 'c')
  assert.equal(selectDateOnly(dated, '2026-10-25').length, 1)
  assert.equal(selectTaskDays(dated, 'undated', '2026-10-25', { from: '', to: '' })[0]!.days.length, 0)
})

test('unknown work completion/reopen uses immutable completion target and keeps null/0/null authoritative states', () => {
  const incomplete = { ...occurrenceFixture(null, false), logicalDate: null, remainingWorkMinutes: null, constraintsSnapshot: { ...occurrenceFixture().constraintsSnapshot, workOrigin: 'unspecified' as const, durationPolicy: null } }
  assert.equal(hasCurrentCompletion(incomplete), true); assert.equal(completionIntent(incomplete).action, 'complete')
  const completed = { ...incomplete, completionStatus: 'completed' as const, completion: occurrenceFixture(completionA).completion, remainingWorkMinutes: 0 }
  assert.equal(hasCurrentCompletion(completed), true)
  assert.equal(completionCommand(completed, completionIntent(completed)).body.completionId, completionA)
})

test('historical completion/reopen replay remains a closed accepted ACK but cannot replace fresh s3; legacy base normalization never changes frozen bytes', () => {
  const fresh = occurrenceFixture(), old = structuredClone(fresh) as unknown as Record<string, unknown>
  delete old.timeIntent; delete old.resolvedTiming; delete old.placementIssue
  delete (old.constraintsSnapshot as Record<string, unknown>).workOrigin
  const frozen = captureCommand('anna', { method: 'POST', path: `/occurrences/${fresh.id}/completion/reopen`, version: 'old_version', body: { completionId: completionA } })
  const bytes = JSON.stringify(frozen), original = JSON.stringify(old)
  assert.doesNotThrow(() => validateWire({ occurrence: old, planState: plan }, 'OccurrenceMutationResponseU1'))
  assert.throws(() => validateWire(old, 'TaskOccurrenceU1'), SyncSchemaError)
  assert.equal(sameData(editableBase(old), editableBase(fresh)), true)
  assert.equal(JSON.stringify(old), original); assert.equal(JSON.stringify(frozen), bytes)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays, calendarRange, completionTimeLabel, elapsedEnd, instantLabel, intersects, localCandidates, localParts, monday, resolveLocalTime, selectedInstant, startOfLocalDate } from '../src/lib/time.ts'
import { hasTimeLimits, resolvedAvailability } from '../src/lib/availability.ts'
import { initialPlacementStart } from '../src/lib/placement-draft.ts'
import { occurrenceFixture } from './completion-fixture.ts'

test('Berlin spring gap rejects the nonexistent minute without shifting it', () => {
  assert.deepEqual(localCandidates('2026-03-29T02:30:00', 'Europe/Berlin'), [])
  assert.throws(() => selectedInstant('2026-03-29T02:30:00', 'Europe/Berlin', '+01:00'))
})
test('Berlin fold preserves two explicit choices and 90 elapsed minutes', () => {
  assert.deepEqual(localCandidates('2026-10-25T02:30:00', 'Europe/Berlin'), [
    { utcOffset: '+02:00', instant: '2026-10-25T00:30:00Z' },
    { utcOffset: '+01:00', instant: '2026-10-25T01:30:00Z' },
  ])
  assert.throws(() => selectedInstant('2026-10-25T02:30:00', 'Europe/Berlin', ''))
  assert.throws(() => selectedInstant('2026-10-25T02:30:00', 'Europe/Berlin', '+03:00'))
  assert.equal(elapsedEnd('2026-10-25T00:30:00Z', 90), '2026-10-25T02:00:00Z')
  assert.equal(localParts('2026-10-25T02:00:00Z', 'Europe/Berlin').time, '03:00')
})
test('day and Monday week boundaries use IANA: Berlin 23/25h days and 167/169h weeks', () => {
  const spring = calendarRange('2026-03-29', 'day', 'Europe/Berlin')
  assert.equal(spring.from, '2026-03-28T23:00:00Z'); assert.equal(spring.to, '2026-03-29T22:00:00Z')
  const fall = calendarRange('2026-10-25', 'day', 'Europe/Berlin')
  assert.equal(fall.from, '2026-10-24T22:00:00Z'); assert.equal(fall.to, '2026-10-25T23:00:00Z')
  const duration = (range: { from: string; to: string }) => (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000
  assert.equal(duration(spring), 23); assert.equal(duration(fall), 25)
  assert.equal(duration(calendarRange('2026-03-29', 'week', 'Europe/Berlin')), 167)
  assert.equal(duration(calendarRange('2026-10-25', 'week', 'Europe/Berlin')), 169)
  assert.equal(monday('2026-10-25'), '2026-10-19')
})
test('Lord Howe has a half-hour fold/gap, not an assumed one-hour DST transition', () => {
  assert.deepEqual(localCandidates('2026-04-05T01:45:00', 'Australia/Lord_Howe').map(item => item.utcOffset), ['+11:00', '+10:30'])
  assert.deepEqual(localCandidates('2026-10-04T02:15:00', 'Australia/Lord_Howe'), [])
  const range = calendarRange('2026-10-04', 'day', 'Australia/Lord_Howe')
  assert.equal((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000, 23.5)
})
test('Santiago midnight gap starts calendar at the first real minute without changing manual input', () => {
  assert.deepEqual(localCandidates('2026-09-06T00:30:00', 'America/Santiago'), [])
  assert.equal(startOfLocalDate('2026-09-06', 'America/Santiago'), '2026-09-06T04:00:00Z')
  assert.equal(localParts(startOfLocalDate('2026-09-06', 'America/Santiago'), 'America/Santiago').time, '01:00')
  const range = calendarRange('2026-09-06', 'day', 'America/Santiago')
  assert.equal((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000, 23)
})
test('night blocks intersect both local days, while touching excluded upper bound does not', () => {
  const first = calendarRange('2026-10-12', 'day', 'Europe/Moscow')
  const second = calendarRange('2026-10-13', 'day', 'Europe/Moscow')
  assert.equal(intersects('2026-10-12T20:00:00Z', '2026-10-12T23:00:00Z', first.from, first.to), true)
  assert.equal(intersects('2026-10-12T20:00:00Z', '2026-10-12T23:00:00Z', second.from, second.to), true)
  assert.equal(intersects(first.to, '2026-10-12T23:00:00Z', first.from, first.to), false)
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.throws(() => addDays('2026-02-30', 1))
})
test('ordinary local times resolve their only offset automatically; folds require an explicit valid choice', () => {
  assert.deepEqual(resolveLocalTime('2026-10-16T09:00:00', 'Europe/Moscow'), { utcOffset: '+03:00', instant: '2026-10-16T06:00:00Z' })
  assert.equal(resolveLocalTime('2026-10-16T09:00:00', 'Europe/Berlin', '+01:00').utcOffset, '+02:00')
  assert.throws(() => resolveLocalTime('2026-10-25T02:30:00', 'Europe/Berlin'), /дважды/)
  assert.throws(() => resolveLocalTime('2026-10-25T02:30:00', 'Europe/Berlin', '+03:00'), /дважды/)
  assert.equal(resolveLocalTime('2026-10-25T02:30:00', 'Europe/Berlin', '+01:00').instant, '2026-10-25T01:30:00Z')
  assert.throws(() => resolveLocalTime('2026-03-29T02:30:00', 'Europe/Berlin'), /не существует/)
})
test('exception requests resolve ordinary boundaries and retain explicit DST/night choices without changing saved input', () => {
  const rules = { timezone: 'Europe/Berlin', windows: [], dateExceptions: [{ localDate: '2026-10-24', windows: [{ startLocalTime: '23:00', endLocalTime: '02:30', endDayOffset: 1 as const, startUtcOffset: '', endUtcOffset: '+01:00' }] }] }
  const result = resolvedAvailability(rules)
  assert.equal(result.dateExceptions[0]?.windows[0]?.startUtcOffset, '+02:00')
  assert.equal(result.dateExceptions[0]?.windows[0]?.endUtcOffset, '+01:00')
  assert.equal(rules.dateExceptions[0]?.windows[0]?.startUtcOffset, '')
  assert.throws(() => resolvedAvailability({ ...rules, dateExceptions: [{ ...rules.dateExceptions[0]!, windows: [{ ...rules.dateExceptions[0]!.windows[0]!, endUtcOffset: '' }] }] }), /дважды/)
  assert.throws(() => resolvedAvailability({ ...rules, dateExceptions: [{ localDate: '2026-03-29', windows: [{ startLocalTime: '02:30', endLocalTime: '04:00', endDayOffset: 0, startUtcOffset: '', endUtcOffset: '' }] }] }), /не существует/)
  assert.equal(hasTimeLimits(rules), true)
  assert.equal(hasTimeLimits({ timezone: rules.timezone, windows: [], dateExceptions: [] }), false)
  assert.throws(() => resolvedAvailability({ timezone: rules.timezone, windows: [], dateExceptions: [{ localDate: '', windows: [] }] }), /дату каждого исключения/)
  assert.throws(() => resolvedAvailability({ timezone: rules.timezone, windows: [{ daysOfWeek: ['monday'], startLocalTime: '', endLocalTime: '18:00', endDayOffset: 0 }], dateExceptions: [] }), /каждого разрешённого окна/)
})
test('placement uses an explicit intent or actual block; an unknown start never invents 09:00', () => {
  const unplanned = occurrenceFixture(null, false)
  assert.equal(initialPlacementStart(unplanned, 'Europe/Moscow'), '')
  unplanned.timeIntent = { timezone: 'Europe/Moscow', startLocalTime: '14:15', endLocalTime: null, endDayOffset: 0, startDisambiguation: null, endDisambiguation: null }
  assert.equal(initialPlacementStart(unplanned, 'Europe/Moscow'), `${unplanned.logicalDate}T14:15`)
  const planned = occurrenceFixture()
  planned.logicalDate = '2026-12-30'
  assert.equal(initialPlacementStart(planned, 'Europe/Berlin'), '2026-10-25T02:30')
})
test('ordinary time labels omit GMT/offset but still honor the chosen IANA zone', () => {
  const instant = '2026-10-16T06:15:30.123Z'
  for (const label of [instantLabel(instant, 'Europe/Moscow'), completionTimeLabel(instant, 'Europe/Moscow')]) {
    assert.doesNotMatch(label, /GMT|UTC|\+03/)
    assert.match(label, /09:15/)
  }
  assert.match(instantLabel(instant, 'UTC'), /06:15/)
})

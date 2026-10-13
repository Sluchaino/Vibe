import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays, calendarRange, elapsedEnd, intersects, localCandidates, localParts, monday, selectedInstant, startOfLocalDate } from '../src/lib/time.ts'

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

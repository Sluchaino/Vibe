import test from 'node:test'
import assert from 'node:assert/strict'
import { localCandidates } from '../src/lib/time.ts'

test('cached local minutes avoid repeated IANA scans, preserve fold choices, and cannot be poisoned by a caller', () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts
  let scans = 0
  Intl.DateTimeFormat.prototype.formatToParts = function (date) { scans++; return original.call(this, date) }
  try {
    const expected = [
      { utcOffset: '+02:00', instant: '2036-10-26T00:30:00Z' },
      { utcOffset: '+01:00', instant: '2036-10-26T01:30:00Z' },
    ]
    const first = localCandidates('2036-10-26T02:30:00', 'Europe/Berlin')
    assert.deepEqual(first, expected)
    const initialScans = scans
    assert.ok(initialScans >= 1681)
    first[0]!.instant = 'changed'; first.pop()
    assert.deepEqual(localCandidates('2036-10-26T02:30:00', 'Europe/Berlin'), expected)
    assert.equal(scans, initialScans, 'a warmed render must not enumerate timezone offsets again')
    assert.notDeepEqual(localCandidates('2036-10-26T02:30:00', 'UTC'), expected, 'timezone is part of the cache key')
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original }
})

test('the local-minute cache is bounded and evicts old entries while retaining recently used ones', () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts
  let scans = 0
  Intl.DateTimeFormat.prototype.formatToParts = function (date) { scans++; return original.call(this, date) }
  try {
    const oldKey = '2037-01-01T00:00:00'
    const expected = localCandidates(oldKey, 'UTC')
    let recent = ''
    for (let index = 0; index < 128; index++) {
      recent = `2037-01-${String(2 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00`
      localCandidates(recent, 'UTC')
    }
    const warmed = scans
    localCandidates(recent, 'UTC')
    assert.equal(scans, warmed)
    assert.deepEqual(localCandidates(oldKey, 'UTC'), expected)
    assert.ok(scans > warmed, 'an evicted key must be recomputed with the original algorithm')
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original }
})

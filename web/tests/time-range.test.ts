import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTimeRange, timeRangeText, timingFromRange } from '../src/lib/time-range.ts'
import { adaptUnifiedDraft, freshUnifiedDraft } from '../src/lib/unified-task.ts'
import { timeIntent, timingPreview, workOrigin } from '../src/lib/task-timing.ts'
import { DraftSession } from '../src/lib/draft-session.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { MemoryStorage } from './storage-memory.ts'

test('text ranges accept both dashes, one start, explicit end-only and deliberate emptiness without inventing a boundary', () => {
  for (const raw of ['10:00 - 11:30', '10:00–11:30', ' 10:00 — 11:30 ']) assert.deepEqual(parseTimeRange(raw), { startTime: '10:00', endTime: '11:30' })
  assert.deepEqual(parseTimeRange('9:05 - 11:30'), { startTime: '09:05', endTime: '11:30' })
  assert.deepEqual(parseTimeRange('10:00'), { startTime: '10:00', endTime: '' })
  assert.deepEqual(parseTimeRange('- 11:30'), { startTime: '', endTime: '11:30' })
  assert.deepEqual(parseTimeRange('  '), { startTime: '', endTime: '' })
})

test('unfinished and malformed raw cannot silently become unknown work or an old valid time', () => {
  for (const raw of ['10:', '10:00 - 1', '24:00 - 11:30', '10:60', '10:00 - 11:30 - 12:00']) {
    assert.throws(() => parseTimeRange(raw))
    const value = { ...freshUnifiedDraft('UTC', 'place', '2026-10-20'), timeRangeRaw: raw }
    value.timing.startTime = '09:00'; value.timing.endTime = '10:00'
    assert.throws(() => timingFromRange(value))
    assert.equal(timeRangeText(value), raw)
  }
  assert.throws(() => parseTimeRange('10:00 -'), /Уточните конец.*уберите дефис/)
})

test('legacy display is read-only; optional raw overrides only hours and preserves date, zone, fold choices and explicit day offset', () => {
  const value = freshUnifiedDraft('Europe/Berlin', 'place', '2026-10-20')
  value.timing = { ...value.timing, logicalDate: '2026-10-25', startTime: '', endTime: '02:30', endDayOffset: '2', endDisambiguation: 'later' }
  const bytes = JSON.stringify(value)
  assert.equal(timeRangeText(value), '- 02:30')
  assert.equal(JSON.stringify(value), bytes)
  assert.equal(Object.hasOwn(value, 'timeRangeRaw'), false)
  assert.deepEqual(timingFromRange(value), value.timing)
  const edited = { ...value, timeRangeRaw: '23:30 - 02:45' }
  assert.deepEqual(timingFromRange(edited), { ...value.timing, startTime: '23:30', endTime: '02:45' })
  assert.equal(timeRangeText(edited), '23:30 - 02:45')
  assert.deepEqual(timingFromRange({ ...edited, timeRangeRaw: '' }), { ...value.timing, startTime: '', endTime: '' })
  assert.equal(JSON.stringify(value), bytes)
})

test('raw mapping keeps elapsed DST volume, explicit night offset and manual mismatch validation', () => {
  const value = { ...freshUnifiedDraft('Europe/Berlin', 'place', '2026-10-20'), timeRangeRaw: '02:30 - 03:30' }
  value.timing.logicalDate = '2026-10-25'; value.timing.startDisambiguation = 'earlier'
  const intent = timeIntent(timingFromRange(value))!
  assert.equal(timingPreview(value.timing.logicalDate, intent, null).minutes, 120)
  assert.equal(workOrigin('', intent), 'interval')
  assert.equal(timingPreview(value.timing.logicalDate, intent, 60).issue, 'workMismatch')
  assert.equal(workOrigin('60', intent), 'manual')
  const night = { ...value, timeRangeRaw: '23:30 - 01:30' }
  assert.equal(timingPreview(value.timing.logicalDate, timeIntent(timingFromRange(night)), null).issue, 'workMismatch')
  assert.equal(timingPreview(value.timing.logicalDate, timeIntent(timingFromRange({ ...night, timing: { ...night.timing, endDayOffset: '1' } })), null).minutes, 120)
  assert.equal(workOrigin('', timeIntent(timingFromRange({ ...value, timeRangeRaw: '02:30' }))), 'unspecified')
})

test('unfinished text survives real emergency and manual DraftSession save/restore with the same identity and saved ID', async () => {
  const storage = new MemoryStorage(), fresh = freshUnifiedDraft('Europe/Moscow', 'place', '2026-10-20')
  const open = (restored: ConstructorParameters<typeof DraftSession>[4] = null) => new DraftSession('anna', 'new-task', fresh, null, restored, async () => storage, () => undefined, 'tab-a')
  const session = open(), id = session.snapshot().draftId
  session.change({ value: { ...fresh, title: 'Мой ввод', timeRangeRaw: '10:00 - 1' } })
  await session.retryEmergency()
  const emergency = (await storage.drafts('anna')).find(row => row.category === 'emergency')!
  const recovered = open(emergency)
  assert.equal(timeRangeText(recovered.snapshot().value as typeof fresh), '10:00 - 1')
  assert.throws(() => timingFromRange(recovered.snapshot().value as typeof fresh))
  await session.save()
  const manual = (await storage.drafts('anna')).find(row => row.category === 'manual')!
  assert.equal(manual.draftId, id)
  const reopened = open(manual)
  assert.equal(reopened.dirty, false)
  assert.equal(timeRangeText(reopened.snapshot().value as typeof fresh), '10:00 - 1')
  reopened.change({ value: { ...reopened.snapshot().value as typeof fresh, timeRangeRaw: '10:00 - 11:30' } })
  await reopened.save()
  assert.equal((await storage.drafts('anna')).filter(row => row.category === 'manual').length, 1)
  assert.equal((await storage.drafts('anna')).find(row => row.category === 'manual')!.draftId, id)
})

test('editing legacy hours keeps historical known work/fold metadata and never changes frozen pending bytes', () => {
  const legacy = { id: 'definition', minutes: '60', firstLocalStart: '2026-10-25T02:30', firstTimezone: 'Europe/Berlin', firstUtcOffset: '+01:00' }
  const frozen = captureCommand('anna', { method: 'POST', path: '/definitions', body: legacy })
  const before = JSON.stringify(frozen), converted = adaptUnifiedDraft(legacy, 'UTC', 'place', '2026-10-20')
  assert.equal(timeRangeText(converted), '02:30')
  assert.equal(timingFromRange({ ...converted, timeRangeRaw: '02:45' }).startDisambiguation, 'later')
  assert.equal(converted.minutes, '60')
  assert.equal(JSON.stringify(frozen), before)
})

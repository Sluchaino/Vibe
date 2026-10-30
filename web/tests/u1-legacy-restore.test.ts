import test from 'node:test'
import assert from 'node:assert/strict'
import type { DraftRecord } from '../src/persistence/database.ts'
import { adaptRestoredUnified, creationEditorSelection, editableLegacyContinuation, legacyInitialRoute, type UnifiedDraft } from '../src/lib/unified-task.ts'
import { prepareCreation } from '../src/lib/creation.ts'
import { defaultRecurrence, prepareRecurring } from '../src/lib/recurrence.ts'
import { DraftSession } from '../src/lib/draft-session.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { freezePending } from '../src/sync/runtime.ts'
import { emptyProjection, replaceItems } from '../src/sync/projection.ts'
import { MemoryStorage } from './storage-memory.ts'
import { items, plan, stream } from './sync-fixture.ts'
import type { TaskDefinition } from '../src/api/types.ts'

const definition = () => items()[1]!.value as TaskDefinition
const unconfirmed = () => replaceItems(emptyProjection(plan, 'a', stream, 0), items().slice(0, 1), plan, 'a')
const confirmed = () => replaceItems(unconfirmed(), items().slice(1, 2), plan, 'b')
function source(key: string, value: unknown): DraftRecord { return { userId: 'anna', draftId: crypto.randomUUID(), category: 'manual', key, value, base: undefined, revision: 2, updatedAt: 10 } }

test('editable legacy one-off + independent continuation before definition ACK uses unified source, stable IDs, optional blanks and same manual CAS id', async () => {
  const id = definition().id, saved = source('new-definition', { id, title: 'Сохранённая задача', minutes: '60', firstOccurrenceDate: '', firstLocalStart: '', firstTimezone: 'Europe/Moscow', firstUtcOffset: '' })
  const continuation = prepareCreation('anna', id, '2026-11-01')
  assert.equal(legacyInitialRoute(saved, [continuation], unconfirmed()), null)
  const restored = adaptRestoredUnified(saved, [continuation], 'Europe/Moscow', definition().placeId, '2026-10-19')
  const value = restored.value as UnifiedDraft
  assert.equal(restored.draftId, saved.draftId); assert.equal(restored.key, saved.key); assert.equal(restored.base, undefined)
  assert.equal(value.id, id); assert.equal(value.occurrenceId, continuation.value.occurrenceId)
  assert.equal(value.minutes, '60'); assert.equal(value.timing.logicalDate, ''); assert.equal(value.timing.startTime, '')
  const storage = new MemoryStorage(); await storage.saveDraft(saved)
  const before = JSON.stringify(await storage.drafts('anna'))
  const editor = new DraftSession('anna', saved.key, value, restored.base, restored, async () => storage, () => undefined, 'tab')
  assert.equal(editor.dirty, false); assert.equal(JSON.stringify(await storage.drafts('anna')), before)
  editor.change({ value: { ...value, repeat: 'interval', intervalDays: '2', minutes: '', timing: { ...value.timing, logicalDate: '' } } })
  await editor.save()
  const stored = (await storage.drafts('anna')).find(row => row.category === 'manual')!
  assert.equal(stored.draftId, saved.draftId); assert.equal(stored.revision, 3)
  assert.equal((stored.value as UnifiedDraft).repeat, 'interval'); assert.equal((stored.value as UnifiedDraft).occurrenceId, continuation.value.occurrenceId)
})

test('legacy recurring initial draft restores all schedule and fold settings in unified; changing everyN keeps the same draft and rule identity', () => {
  const id = definition().id, schedule = { ...defaultRecurrence('Europe/Berlin', '2026-10-25'), daysOfWeek: ['sunday'] as const, endDate: '2026-12-20' }
  const saved = source('new-recurring-definition', { id, title: 'Повторение', minutes: '60', firstLocalStart: '2026-10-25T02:30', firstTimezone: 'Europe/Berlin', firstUtcOffset: '+01:00' })
  const continuation = prepareRecurring('anna', id, { ...schedule, daysOfWeek: [...schedule.daysOfWeek] })
  assert.equal(legacyInitialRoute(saved, [continuation], unconfirmed()), null)
  const restored = adaptRestoredUnified(saved, [continuation], 'UTC', definition().placeId, '2026-10-19'), value = restored.value as UnifiedDraft
  assert.equal(restored.draftId, saved.draftId); assert.equal(value.ruleId, schedule.id)
  assert.equal(value.timing.timezone, 'Europe/Berlin'); assert.equal(value.timing.startDisambiguation, 'later')
  assert.deepEqual(value.daysOfWeek, ['sunday']); assert.equal(value.endDate, '2026-12-20'); assert.equal(value.minutes, '60')
  assert.equal({ ...value, repeat: 'interval', intervalDays: '3' }.ruleId, schedule.id)
})

test('direct pre-definition continuation opens its saved editable source; confirmed workflows retain their original explicit route', () => {
  const id = definition().id, saved = source('new-definition', { id, title: 'Исходная задача', minutes: '60' }), continuation = prepareCreation('anna', id, '2026-11-01', undefined, { localStart: '2026-11-01T09:00', timezone: 'Europe/Moscow', utcOffset: '+03:00' })
  const selected = editableLegacyContinuation(continuation, [saved, continuation], unconfirmed())!
  assert.equal(selected.draftId, saved.draftId)
  const value = adaptRestoredUnified(selected, [saved, continuation], 'UTC', definition().placeId, '2026-10-19').value as UnifiedDraft
  assert.equal(value.occurrenceId, continuation.value.occurrenceId); assert.equal(value.timing.logicalDate, '2026-11-01'); assert.equal(value.timing.startTime, '09:00'); assert.equal(value.minutes, '60')
  assert.equal(editableLegacyContinuation(continuation, [saved, continuation], confirmed()), null)
  assert.equal(legacyInitialRoute(saved, [continuation], confirmed()), 'oneOff')
  const recurring = prepareRecurring('anna', id, defaultRecurrence('Europe/Berlin', '2026-11-01'))
  const recurringSource = source('new-recurring-definition', { id, minutes: '60' })
  assert.equal(legacyInitialRoute(recurringSource, [recurring], confirmed()), 'recurring')
})

test('a pre-definition continuation with no saved source keeps its identities/time but does not invent title/work or overwrite the continuation', () => {
  const continuation = prepareCreation('anna', definition().id, '2026-11-01'), before = JSON.stringify(continuation)
  const selected = editableLegacyContinuation(continuation, [continuation], unconfirmed())!
  assert.notEqual(selected.draftId, continuation.draftId); assert.equal(selected.category, 'manual')
  const value = adaptRestoredUnified(selected, [continuation], 'Europe/Moscow', definition().placeId, '2026-10-19').value as UnifiedDraft
  assert.equal(value.id, continuation.value.definitionId); assert.equal(value.occurrenceId, continuation.value.occurrenceId)
  assert.equal(value.timing.logicalDate, '2026-11-01'); assert.equal(value.timing.startTime, ''); assert.equal(value.minutes, ''); assert.equal(value.title, '')
  assert.equal(JSON.stringify(continuation), before)
})

test('legacy adaptation never edits frozen pending JSON, and foreign continuation IDs/settings cannot replace the selected owner source', async () => {
  const id = definition().id, saved = source('new-definition', { id, title: 'Первоначальная задача', minutes: '60', firstLocalStart: '2026-10-25T02:30', firstTimezone: 'Europe/Berlin', firstUtcOffset: '+02:00' })
  const frozen = freezePending(captureCommand('anna', { method: 'POST', path: '/task-definitions', body: { id, title: 'Первоначальная задача', durationPolicy: { mode: 'fixedWork', requiredWorkMinutes: 60 } } }), saved, stream)
  const storage = new MemoryStorage(); await storage.reserve(frozen, saved)
  const foreign = { ...prepareCreation('boris', id, '2026-11-03'), userId: 'boris' }, before = JSON.stringify(await storage.getPending('anna'))
  const restored = adaptRestoredUnified(saved, [foreign], 'UTC', definition().placeId, '2026-10-19'), value = restored.value as UnifiedDraft
  assert.notEqual(value.occurrenceId, foreign.value.occurrenceId); assert.equal(value.timing.startDisambiguation, 'earlier'); assert.equal(value.minutes, '60')
  assert.equal(JSON.stringify(await storage.getPending('anna')), before)
  assert.equal(legacyInitialRoute(saved, [foreign], confirmed()), null)
})

test('an open unified legacy editor keeps its selected route and edited everyN value when sync confirms the definition', () => {
  const id = definition().id, saved = source('new-definition', { id, title: 'Legacy → every N', minutes: '60' }), continuation = prepareCreation('anna', id, '2026-11-01')
  const records = [saved, continuation]
  // NewTaskFlow stores this selection once for the lifetime of its editor.
  const opened = creationEditorSelection(saved, records, unconfirmed())
  assert.equal(opened.route, 'unified')
  const restored = adaptRestoredUnified(opened.restore!, records, 'Europe/Berlin', definition().placeId, '2026-10-19')
  const editor = new DraftSession('anna', restored.key, restored.value, restored.base, restored, async () => new MemoryStorage(), () => undefined, 'tab')
  editor.change({ value: { ...(editor.snapshot().value as UnifiedDraft), repeat: 'interval', intervalDays: '2' } })
  const sessionId = editor.snapshot().draftId
  assert.equal(legacyInitialRoute(saved, records, confirmed()), 'oneOff', 'recalculating an open route would wrongly return to legacy')
  assert.equal(opened.route, 'unified'); assert.equal(editor.snapshot().draftId, sessionId)
  assert.equal((editor.snapshot().value as UnifiedDraft).repeat, 'interval'); assert.equal((editor.snapshot().value as UnifiedDraft).intervalDays, '2')
  assert.equal((editor.snapshot().value as UnifiedDraft).occurrenceId, continuation.value.occurrenceId)
  assert.equal(creationEditorSelection(saved, records, confirmed()).route, 'oneOff', 'a separate reopen of an already confirmed legacy workflow retains compatibility')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskOccurrence } from '../src/api/types.ts'
import { openDraft, rebaseDraft } from '../src/lib/drafts.ts'
import { assertPlacementAction, placementActionProblem, placementActions, type PlacementAction } from '../src/lib/operations.ts'

const withBlock: Pick<TaskOccurrence, 'calendarBlock'> = { calendarBlock: { id: '30000000-0000-4000-8000-000000000001', occurrenceId: '40000000-0000-4000-8000-000000000001', kind: 'task', startInstant: '2026-10-13T07:00:00Z', endInstant: '2026-10-13T08:30:00Z', fixed: true, serverVersion: 'block_v1' } }
const withoutBlock: Pick<TaskOccurrence, 'calendarBlock'> = { calendarBlock: null }
function input(action: PlacementAction) { return { action, localStart: '2026-10-25T02:30', timezone: 'Europe/Berlin', utcOffset: '+01:00', fixed: false } }

test('move draft rebased after unplace preserves all intent but requires explicit place before submission', () => {
  const original = openDraft(undefined, input('move'), { occurrence: withBlock, scheduleVersion: 'schedule_v1' })
  const rebased = rebaseDraft(original, { occurrence: withoutBlock, scheduleVersion: 'schedule_v2' })
  assert.deepEqual(rebased.value, original.value)
  assert.deepEqual(placementActions(rebased.base.occurrence), ['place'])
  assert.match(placementActionProblem(rebased.base.occurrence, rebased.value.action)!, /больше нет блока/)
  assert.throws(() => assertPlacementAction(rebased.base.occurrence, rebased.value.action))
  const reopened = openDraft(rebased, input('place'), { occurrence: withoutBlock, scheduleVersion: 'schedule_v3' })
  assert.deepEqual(reopened, rebased)
  assert.throws(() => assertPlacementAction(reopened.base.occurrence, reopened.value.action))
  const explicitlyChosen = { ...reopened.value, action: 'place' as const }
  assert.doesNotThrow(() => assertPlacementAction(reopened.base.occurrence, explicitlyChosen.action))
  assert.equal(explicitlyChosen.localStart, original.value.localStart)
  assert.equal(explicitlyChosen.utcOffset, original.value.utcOffset)
})
test('place draft rebased after another tab places stays place until explicit choice for existing block', () => {
  const original = openDraft(undefined, input('place'), { occurrence: withoutBlock, scheduleVersion: 'schedule_v1' })
  const rebased = rebaseDraft(original, { occurrence: withBlock, scheduleVersion: 'schedule_v2' })
  assert.deepEqual(rebased.value, original.value)
  assert.deepEqual(placementActions(rebased.base.occurrence), ['move', 'unplace', 'setFixed'])
  assert.match(placementActionProblem(rebased.base.occurrence, rebased.value.action)!, /теперь есть блок/)
  assert.throws(() => assertPlacementAction(rebased.base.occurrence, rebased.value.action))
  for (const action of placementActions(rebased.base.occurrence)) assert.doesNotThrow(() => assertPlacementAction(rebased.base.occurrence, action))
  assert.throws(() => assertPlacementAction(withoutBlock, 'unplace'))
  assert.throws(() => assertPlacementAction(withoutBlock, 'setFixed'))
})

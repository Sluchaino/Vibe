import test from 'node:test'
import assert from 'node:assert/strict'
import { assertOccurrenceEditable, calendarMinutes, completionCommand, completionIntent, hasCurrentCompletion, occurrenceListPath } from '../src/lib/completion.ts'
import { captureCommand, fixedConfirmation } from '../src/lib/operations.ts'
import { openDraft, rebaseDraft } from '../src/lib/drafts.ts'
import { completionTimeLabel } from '../src/lib/time.ts'
import { completionA, completionB, occurrenceFixture, occurrenceId } from './completion-fixture.ts'

test('targeted reopen retains A and original version for retry even after fresh active B and explicit base refresh', () => {
  const observedA = occurrenceFixture(completionA)
  const intentA = completionIntent(observedA)
  const pending = captureCommand('anna', completionCommand(observedA, intentA), '10000000-0000-4000-8000-000000000081')
  const freshB = occurrenceFixture(completionB)
  const draft = rebaseDraft(openDraft(undefined, intentA, observedA), freshB)
  assert.equal(pending.path, `/occurrences/${occurrenceId}/completion/reopen`)
  assert.equal(pending.version, observedA.serverVersion)
  assert.equal(pending.body.completionId, completionA)
  assert.equal(completionCommand(draft.base, draft.value).body.completionId, completionA)
  const explicitNewIntent = captureCommand('anna', completionCommand(freshB, completionIntent(freshB)), '10000000-0000-4000-8000-000000000082')
  assert.equal(explicitNewIntent.body.completionId, completionB)
  assert.notEqual(explicitNewIntent.opId, pending.opId)
  assert.equal(pending.body.completionId, completionA)
})
test('mark request carries only opId; reopen carries only opId and selected completionId', () => {
  const mark = captureCommand('anna', completionCommand(occurrenceFixture(), completionIntent(occurrenceFixture())))
  assert.deepEqual(Object.keys(mark.body), ['opId'])
  const undo = captureCommand('anna', completionCommand(occurrenceFixture(completionA), completionIntent(occurrenceFixture(completionA))))
  assert.deepEqual(Object.keys(undo.body).sort(), ['completionId', 'opId'])
})
test('active snapshot/placement guards reject complete state, including a rebased draft; reopen restores D1 guard', () => {
  const complete = occurrenceFixture(completionA)
  assert.equal(hasCurrentCompletion(complete), true)
  assert.throws(() => assertOccurrenceEditable(complete), /Сначала снимите/)
  const draft = rebaseDraft(openDraft(undefined, { minutes: '60' }, occurrenceFixture()), complete)
  assert.deepEqual(draft.value, { minutes: '60' })
  assert.throws(() => assertOccurrenceEditable(draft.base))
  const reopened = occurrenceFixture()
  assert.doesNotThrow(() => assertOccurrenceEditable(reopened))
  assert.equal(fixedConfirmation(reopened, 'move'), true)
  const legacy = { ...reopened } as Partial<typeof reopened>
  delete legacy.completionStatus; delete legacy.completion
  assert.equal(hasCurrentCompletion(legacy as typeof reopened), false)
  assert.throws(() => assertOccurrenceEditable(legacy as typeof reopened))
})
test('completed calendar block still has 90 elapsed minutes across DST despite remaining=0', () => {
  const complete = occurrenceFixture(completionA)
  assert.equal(complete.remainingWorkMinutes, 0)
  assert.equal(calendarMinutes(complete.calendarBlock!), 90)
  assert.equal(complete.constraintsSnapshot.durationPolicy.requiredWorkMinutes, 90)
  const reopened = occurrenceFixture()
  assert.deepEqual(reopened.calendarBlock, complete.calendarBlock)
  assert.equal(calendarMinutes(reopened.calendarBlock!), 90)
  assert.match(completionTimeLabel(complete.completion!.completedAt, 'Europe/Moscow'), /13:15:42/)
})
test('worklist excludes completed unplanned, while all/completed remain server-queryable', () => {
  assert.equal(occurrenceListPath('incomplete', undefined, true), '/occurrences?placementStatus=unplanned&completionStatus=incomplete')
  assert.equal(occurrenceListPath('all'), '/occurrences')
  assert.equal(occurrenceListPath('completed', occurrenceId), `/occurrences?definitionId=${occurrenceId}&completionStatus=completed`)
  assert.equal(occurrenceListPath('all', undefined, true), '/occurrences?placementStatus=unplanned')
})

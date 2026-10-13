import test from 'node:test'
import assert from 'node:assert/strict'
import { openDraft, rebaseDraft } from '../src/lib/drafts.ts'
import { assertCommandIdentity, captureCommand, codePointLength, effectiveFixed, fixedConfirmation } from '../src/lib/operations.ts'
import { IdentityState } from '../src/state/session.ts'
import type { TaskOccurrence } from '../src/api/types.ts'

test('reopened draft keeps v1 despite new v2 GET; manual rebase preserves every input and starts a new operation', () => {
  const first = openDraft(undefined, { title: 'Мой текст', minutes: '90', windows: ['night'] }, { serverVersion: 'v1', definitionVersion: 'd1', scheduleVersion: 's1' })
  const store = new IdentityState(); store.activate('anna'); store.setDraft('anna', 'definition', first)
  const freshBase = { serverVersion: 'v2', definitionVersion: 'd2', scheduleVersion: 's2' }
  const reopened = openDraft(store.getDraft<typeof first>('anna', 'definition'), { title: 'Текст Бориса', minutes: '60', windows: [] }, freshBase)
  assert.deepEqual(reopened, first)
  const rejected = captureCommand('anna', { method: 'PUT', path: '/task-definitions/id', version: reopened.base.serverVersion, body: reopened.value }, '10000000-0000-4000-8000-000000000001')
  const rebased = rebaseDraft(reopened, freshBase)
  const replacement = captureCommand('anna', { method: 'PUT', path: rejected.path, version: rebased.base.serverVersion, body: rebased.value }, '10000000-0000-4000-8000-000000000002')
  assert.deepEqual(rebased.value, first.value); assert.deepEqual(rebased.base, freshBase)
  assert.equal(rejected.version, 'v1'); assert.equal(replacement.version, 'v2'); assert.notEqual(rejected.opId, replacement.opId)
})
test('two identities have separate drafts and cannot send an old account command', () => {
  const store = new IdentityState(); store.activate('anna'); store.setDraft('anna', 'settings', { name: 'Дом A' })
  store.activate('boris'); assert.equal(store.getDraft('boris', 'settings'), undefined)
  store.setDraft('boris', 'settings', { name: 'Дом B' })
  assert.deepEqual(store.getDraft('anna', 'settings'), { name: 'Дом A' })
  const command = captureCommand('anna', { method: 'PUT', path: '/settings', body: { name: 'Дом A' } }, '10000000-0000-4000-8000-000000000003')
  assert.throws(() => assertCommandIdentity(command, 'boris')); assert.throws(() => assertCommandIdentity(command, null))
  assert.doesNotThrow(() => assertCommandIdentity(command, 'anna'))
})
test('captured retry is immutable even if form fields change', () => {
  const body = { title: 'Исходный ввод', constraints: { minutes: 90 } }
  const pending = captureCommand('anna', { method: 'POST', path: '/task-definitions', body }, '10000000-0000-4000-8000-000000000003')
  body.title = 'Другой ввод'; body.constraints.minutes = 30
  assert.deepEqual(pending.body, { title: 'Исходный ввод', constraints: { minutes: 90 }, opId: '10000000-0000-4000-8000-000000000003' })
  assert.equal(codePointLength('😀🌿'), 2)
})
test('policy protection survives unsetting block flag; move/unplace/policy removal require confirmation', () => {
  const occurrence = { calendarBlock: { fixed: false }, constraintsSnapshot: { mobilityPolicy: 'fixedAfterPlacement' } } as TaskOccurrence
  assert.equal(effectiveFixed(occurrence), true)
  assert.equal(fixedConfirmation(occurrence, 'move'), true); assert.equal(fixedConfirmation(occurrence, 'unplace'), true)
  assert.equal(fixedConfirmation(occurrence, 'snapshot', undefined, 'movable'), true)
  assert.equal(fixedConfirmation(occurrence, 'setFixed', false), false)
  occurrence.calendarBlock!.fixed = true
  assert.equal(fixedConfirmation(occurrence, 'setFixed', false), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { freshAfterAcknowledgement } from '../src/lib/fresh-read.ts'
import { PageRequestGate } from '../src/lib/paging.ts'
import { afterRefresh, CommandLifecycle, settleAcknowledgement } from '../src/lib/command-lifecycle.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { IdentityState } from '../src/state/session.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
test('ACK refresh waits for related lists then latest authoritative read; legacy ACK is not published', async () => {
  const read = deferred<{ completionId: string }>(); const related = deferred<void>()
  const published: string[] = []; const order: string[] = []
  const refresh = freshAfterAcknowledgement(() => { order.push('current'); return read.promise }, () => { order.push('related'); return related.promise }, () => true, value => published.push(value.completionId))
  assert.deepEqual(order, ['related'])
  related.resolve(); await Promise.resolve()
  assert.deepEqual(order, ['related', 'current']); assert.deepEqual(published, [])
  read.resolve({ completionId: 'new-active-B' }); assert.equal(await refresh, true)
  assert.deepEqual(published, ['new-active-B'])
})
test('read or related refresh failure propagates; no false publication/confirmed status', async () => {
  let publications = 0
  await assert.rejects(freshAfterAcknowledgement(() => Promise.reject(new Error('401 or offline')), async () => undefined, () => true, () => { publications++ }))
  await assert.rejects(freshAfterAcknowledgement(async () => ({ completed: true }), () => Promise.reject(new Error('calendar unavailable')), () => true, () => { publications++ }))
  assert.equal(publications, 0)
})
test('identity change during read suppresses old account publication', async () => {
  const read = deferred<{ completed: boolean }>(); let scope = true; let publications = 0
  const refresh = freshAfterAcknowledgement(() => read.promise, async () => undefined, () => scope, () => { publications++ })
  await Promise.resolve(); scope = false; read.resolve({ completed: true })
  assert.equal(await refresh, false); assert.equal(publications, 0)
})
test('filter change invalidates old page before new response arrives', () => {
  const gate = new PageRequestGate()
  const oldPage = gate.begin('completionStatus=incomplete')
  gate.select('completionStatus=completed')
  assert.equal(gate.accepts(oldPage), false)
  const newPage = gate.begin('completionStatus=completed')
  assert.equal(gate.accepts(newPage), true)
  const newerPage = gate.begin('completionStatus=completed')
  assert.equal(gate.accepts(newPage), false); assert.equal(gate.accepts(newerPage), true)
})
test('acknowledged operation with failed refresh returns false and leaves editor open', async () => {
  const state = new IdentityState(); state.activate('anna')
  const lifecycle = new CommandLifecycle('anna', 'pending:completion', state); lifecycle.mount()
  const ticket = lifecycle.begin(captureCommand('anna', { method: 'POST', path: '/completion', body: {} }))!
  let editorClosed = false
  const result = await settleAcknowledgement(lifecycle, ticket, current => afterRefresh(current, () => undefined, () => Promise.reject(new Error('read failed')), () => { editorClosed = true }))
  assert.equal(result.success, false); assert.ok(result.refreshError); assert.equal(editorClosed, false)
  assert.equal(state.getDraft('anna', 'pending:completion'), undefined)
})
test('late ACK after editor unmount still refreshes owner data but never closes newer editor', async () => {
  const state = new IdentityState(); state.activate('anna')
  const lifecycle = new CommandLifecycle('anna', 'pending:completion', state); lifecycle.mount()
  const ticket = lifecycle.begin(captureCommand('anna', { method: 'POST', path: '/completion', body: {} }))!
  lifecycle.unmount()
  let refreshed = false; let editorClosed = false
  const result = await settleAcknowledgement(lifecycle, ticket, async current => { refreshed = true; if (current()) editorClosed = true })
  assert.equal(refreshed, true); assert.equal(editorClosed, false); assert.equal(result.success, false)
})

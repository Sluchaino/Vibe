import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandLifecycle, afterRefresh } from '../src/lib/command-lifecycle.ts'
import { ApiError, IdentityChangedError, NetworkError, mutate, resetTransport, setExpiredHandler } from '../src/api/client.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { IdentityState, identityState } from '../src/state/session.ts'

const op1 = '20000000-0000-4000-8000-000000000001'
const op2 = '20000000-0000-4000-8000-000000000002'
function command(opId: typeof op1 | typeof op2 = op1) { return captureCommand('anna', { method: 'PUT', path: '/settings', version: 'v1', body: { name: 'Мой ввод' } }, opId) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function problem(status: number) { return new ApiError({ type: 'about:blank', title: 'Error', status, detail: '', instance: '', code: status === 401 ? 'unauthorized' : 'staleEntity', correlationId: 'test' }) }

test('late ACK of duplicate A1 cannot remove new A2 tracker or its draft', async () => {
  const state = new IdentityState(); state.activate('anna')
  const oldForm = new CommandLifecycle('anna', 'pending:settings', state); oldForm.mount()
  const oldTicket = oldForm.begin(command())!
  const lateAck = deferred<void>()
  let callbacks = 0
  const oldDelivery = lateAck.promise.then(() => { const matched = oldForm.clearPending(oldTicket); if (matched && oldForm.current(oldTicket)) callbacks++; oldForm.end(oldTicket) })
  oldForm.unmount()
  const reopened = new CommandLifecycle('anna', 'pending:settings', state); reopened.mount()
  const retryTicket = reopened.begin(command())!
  assert.equal(reopened.clearPending(retryTicket), true); reopened.end(retryTicket)
  const newTicket = reopened.begin(command(op2))!
  state.setDraft('anna', 'versioned:settings', { value: { name: 'Новый ввод A2' }, base: { serverVersion: 'v2' } })
  lateAck.resolve(); await oldDelivery
  assert.equal(state.getDraft<{ opId: string }>('anna', 'pending:settings')?.opId, op2)
  assert.deepEqual(state.getDraft('anna', 'versioned:settings'), { value: { name: 'Новый ввод A2' }, base: { serverVersion: 'v2' } })
  assert.equal(callbacks, 0); assert.equal(reopened.current(newTicket), true)
})
test('late final error A1 also leaves A2 tracker/draft intact', async () => {
  const state = new IdentityState(); state.activate('anna')
  const oldForm = new CommandLifecycle('anna', 'pending:definition', state); oldForm.mount()
  const ticket = oldForm.begin(command())!
  const lateError = deferred<void>()
  const oldDelivery = lateError.promise.then(() => oldForm.fail(ticket, problem(412)))
  oldForm.unmount()
  state.setDraft('anna', 'pending:definition', command(op2))
  state.setDraft('anna', 'versioned:definition', { title: 'Свежий ввод' })
  lateError.resolve(); await oldDelivery
  assert.equal(state.getDraft<{ opId: string }>('anna', 'pending:definition')?.opId, op2)
  assert.deepEqual(state.getDraft('anna', 'versioned:definition'), { title: 'Свежий ввод' })
})
test('callback rechecks mount after awaited refresh and never closes a new editor', async () => {
  const state = new IdentityState(); state.activate('anna')
  const lifecycle = new CommandLifecycle('anna', 'pending:definition', state); lifecycle.mount()
  const ticket = lifecycle.begin(command())!
  lifecycle.clearPending(ticket)
  const refresh = deferred<void>()
  let editor = 'A'
  let beforeCalls = 0
  const callback = afterRefresh(() => lifecycle.current(ticket), () => { beforeCalls++ }, () => refresh.promise, () => { editor = 'closed' })
  assert.equal(beforeCalls, 1)
  lifecycle.unmount(); editor = 'B'
  refresh.resolve(); await callback
  assert.equal(editor, 'B')
  await afterRefresh(() => lifecycle.current(ticket), () => { beforeCalls++ }, () => undefined, () => { editor = 'closed' })
  assert.equal(beforeCalls, 1); assert.equal(editor, 'B')
})
test('synchronous begin rejects double submit before any React rerender and preserves first opId', () => {
  const state = new IdentityState(); state.activate('anna')
  const lifecycle = new CommandLifecycle('anna', 'pending:settings', state); lifecycle.mount()
  const first = lifecycle.begin(command())!
  assert.equal(lifecycle.begin(command(op2)), null)
  assert.equal(state.getDraft<{ opId: string }>('anna', 'pending:settings')?.opId, op1)
  lifecycle.end(first)
  assert.equal(lifecycle.begin(command(op2)), null) // original pending must first be retried
})
test('identity change, 401 and unknown delivery keep original pending; final 412 clears only its own tracker', () => {
  for (const error of [new IdentityChangedError('Changed'), new NetworkError('Lost'), problem(401), problem(503)]) {
    const state = new IdentityState(); state.activate('anna')
    const lifecycle = new CommandLifecycle('anna', 'pending:settings', state); lifecycle.mount()
    const ticket = lifecycle.begin(command())!
    state.activate('boris'); lifecycle.fail(ticket, error)
    assert.equal(state.getDraft<{ opId: string }>('anna', 'pending:settings')?.opId, op1)
    assert.equal(state.getDraft('boris', 'pending:settings'), undefined)
    assert.equal(lifecycle.current(ticket), false)
  }
  const state = new IdentityState(); state.activate('anna')
  const lifecycle = new CommandLifecycle('anna', 'pending:settings', state); lifecycle.mount()
  const ticket = lifecycle.begin(command())!
  lifecycle.fail(ticket, problem(412))
  assert.equal(state.getDraft('anna', 'pending:settings'), undefined)
})
test('actual transport identity change after dispatch/ACK retains original opId for safe retry', async () => {
  const originalFetch = globalThis.fetch
  resetTransport(); identityState.activate('anna')
  setExpiredHandler(() => { identityState.activate(null); resetTransport() })
  const lifecycle = new CommandLifecycle('anna', 'pending:transport-test', identityState); lifecycle.mount()
  const pending = command(); const ticket = lifecycle.begin(pending)!
  const sent = deferred<void>(); const ack = deferred<Response>()
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return new Response(JSON.stringify({ userId: 'anna', userName: 'anna' }))
    if (String(url).endsWith('/auth/antiforgery')) return new Response(JSON.stringify({ requestToken: 'token-A', headerName: 'X-CSRF-TOKEN' }))
    assert.equal(options?.method, 'PUT'); assert.equal(JSON.parse(String(options?.body)).opId, op1)
    sent.resolve(); return ack.promise
  }
  try {
    const delivery = mutate(pending).catch(error => { lifecycle.fail(ticket, error as Error); throw error })
    const rejected = assert.rejects(delivery, IdentityChangedError)
    await sent.promise
    identityState.activate('boris')
    ack.resolve(new Response(JSON.stringify({ settings: { serverVersion: 'committed-v2' } })))
    await rejected
    assert.equal(identityState.getDraft<{ opId: string }>('anna', 'pending:transport-test')?.opId, op1)
    assert.equal(identityState.getDraft('boris', 'pending:transport-test'), undefined)
  } finally {
    lifecycle.unmount(); identityState.clearDraft('anna', 'pending:transport-test')
    resetTransport(); globalThis.fetch = originalFetch; setExpiredHandler(() => undefined)
  }
})

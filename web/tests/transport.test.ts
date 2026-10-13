import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, IdentityChangedError, NetworkError, mutate, read, resetTransport, setExpiredHandler } from '../src/api/client.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { identityState } from '../src/state/session.ts'

const originalFetch = globalThis.fetch
function json(value: unknown, status = 200, extra: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...extra } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => { resetTransport(); identityState.activate('anna'); setExpiredHandler(() => { identityState.activate(null); resetTransport() }) })
afterEach(() => { resetTransport(); globalThis.fetch = originalFetch; setExpiredHandler(() => undefined) })

test('private read checks live cookie identity after payload before exposing data, without BroadcastChannel', async () => {
  identityState.setDraft('anna', 'private-edit', { text: 'Сохранить мой ввод' })
  const calls: string[] = []
  globalThis.fetch = async url => { calls.push(String(url)); return String(url).endsWith('/me') ? json({ userId: 'boris', userName: 'boris' }) : json({ title: 'Данные Бориса' }) }
  await assert.rejects(read('/task-definitions/id'), IdentityChangedError)
  assert.deepEqual(calls, ['/api/v1/task-definitions/id', '/api/v1/me'])
  assert.equal(identityState.userId, null)
  assert.deepEqual(identityState.getDraft('anna', 'private-edit'), { text: 'Сохранить мой ввод' })
  assert.equal(identityState.getDraft('boris', 'private-edit'), undefined)
})
test('late read from previous epoch cannot replace a fresh identity cache', async () => {
  const reply = deferred<Response>()
  globalThis.fetch = async () => reply.promise
  const oldRead = read('/settings')
  identityState.activate('boris')
  const cache = { userId: 'boris', place: 'Дом B' }
  reply.resolve(json({ place: 'Дом A' }))
  await assert.rejects(oldRead, IdentityChangedError)
  assert.deepEqual(cache, { userId: 'boris', place: 'Дом B' })
})
test('network retry sends the identical operation/body/If-Match and reads fresh state after replay', async () => {
  const requests: { body: string; version: string | null; csrf: string | null }[] = []
  let attempts = 0
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (path.endsWith('/me')) return json({ userId: 'anna', userName: 'anna' })
    if (path.endsWith('/auth/antiforgery')) return json({ requestToken: 'token-A', headerName: 'X-CSRF-TOKEN' })
    if (options?.method === 'PUT') {
      const headers = new Headers(options.headers)
      requests.push({ body: String(options.body), version: headers.get('If-Match'), csrf: headers.get('X-CSRF-TOKEN') })
      if (++attempts === 1) throw new TypeError('Lost committed response')
      return json({ settings: { serverVersion: 'old-replayed-version', place: 'old' } }, 200, { 'Idempotency-Replayed': 'true' })
    }
    return json({ settings: { serverVersion: 'fresh-version', place: 'new' } })
  }
  const pending = captureCommand('anna', { method: 'PUT', path: '/settings', version: 'base-v1', body: { timezone: 'Europe/Moscow' } }, '10000000-0000-4000-8000-000000000004')
  await assert.rejects(mutate(pending), NetworkError)
  const ack = await mutate(pending)
  assert.equal(ack.replayed, true)
  const cache = await read<{ settings: { serverVersion: string } }>('/settings')
  assert.equal(cache.settings.serverVersion, 'fresh-version')
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[0]?.version, '"base-v1"'); assert.equal(requests[0]?.csrf, 'token-A')
})
test('403 CSRF refresh keeps opId, payload and ETag; server conflict remains a final error', async () => {
  let tokens = 0
  const bodies: string[] = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return json({ userId: 'anna', userName: 'anna' })
    if (String(url).endsWith('/auth/antiforgery')) return json({ requestToken: `token-${++tokens}`, headerName: 'X-CSRF-TOKEN' })
    bodies.push(String(options?.body))
    if (bodies.length === 1) return json({ type: 'about:blank', title: 'CSRF', status: 403, detail: '', instance: '', code: 'invalidAntiforgery', correlationId: '1' }, 403)
    return json({ type: 'about:blank', title: 'Conflict', status: 412, detail: '', instance: '', code: 'staleEntity', correlationId: '2', currentServerVersion: 'v2' }, 412)
  }
  const pending = captureCommand('anna', { method: 'PUT', path: '/task-definitions/id', version: 'v1', body: { title: 'Мой ввод' } }, '10000000-0000-4000-8000-000000000001')
  await assert.rejects(mutate(pending), (error: unknown) => error instanceof ApiError && error.problem.code === 'staleEntity')
  assert.equal(tokens, 2); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1])
})
test('identity change before mutation cannot deliver an old draft to another cookie account', async () => {
  let writes = 0
  globalThis.fetch = async (_url, options) => { if (options?.method === 'PUT') writes++; return json({ userId: 'boris', userName: 'boris' }) }
  const pending = captureCommand('anna', { method: 'PUT', path: '/settings', body: { place: 'Дом A' } })
  await assert.rejects(mutate(pending), IdentityChangedError)
  assert.equal(writes, 0)
})

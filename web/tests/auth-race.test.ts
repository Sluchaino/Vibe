import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { IdentityChangedError, login, logout, mutate, resetTransport, restoreSession, setExpiredHandler } from '../src/api/client.ts'
import { CommandLifecycle } from '../src/lib/command-lifecycle.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { identityState } from '../src/state/session.ts'

const originalFetch = globalThis.fetch
const opA = '60000000-0000-4000-8000-000000000001'
const opB = '60000000-0000-4000-8000-000000000002'
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function me(userId: string) { return json({ userId, userName: userId }) }
function token(userId: string) { return json({ requestToken: `token-${userId}`, headerName: 'X-CSRF-TOKEN' }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function beginAnna() {
  const pending = captureCommand('anna', { method: 'PUT', path: '/settings', version: 'settings_v1', body: { timezone: 'Europe/Moscow', weekStartsOn: 'monday', place: { id: '70000000-0000-4000-8000-000000000001', name: 'Дом Анны' } } }, opA)
  const lifecycle = new CommandLifecycle('anna', 'pending:auth-race', identityState); lifecycle.mount()
  const ticket = lifecycle.begin(pending)!
  const delivery = () => mutate(pending).catch(error => { lifecycle.fail(ticket, error as Error); throw error })
  return { delivery, lifecycle }
}
function assertAnnaPending() {
  assert.equal(identityState.getDraft<{ opId: string }>('anna', 'pending:auth-race')?.opId, opA)
  assert.equal(identityState.getDraft('boris', 'pending:auth-race'), undefined)
}
beforeEach(() => { resetTransport(); identityState.activate('anna'); setExpiredHandler(() => { identityState.activate(null); resetTransport() }) })
afterEach(() => { resetTransport(); globalThis.fetch = originalFetch; setExpiredHandler(() => undefined); identityState.clearDraft('anna', 'pending:auth-race') })

test('empty-CSRF first send checks cookie owner after awaited bootstrap and never dispatches Anna command as Boris', async () => {
  let cookie = 'anna'; let writes = 0
  const bootStarted = deferred<void>(); const boot = deferred<Response>()
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return me(cookie)
    if (String(url).endsWith('/auth/antiforgery')) { bootStarted.resolve(); return boot.promise }
    if (options?.method === 'PUT') writes++
    return json({})
  }
  const { delivery } = beginAnna()
  const rejected = assert.rejects(delivery(), IdentityChangedError)
  await bootStarted.promise
  cookie = 'boris' // no epoch change and no BroadcastChannel delivery
  boot.resolve(token('boris'))
  await rejected
  assert.equal(writes, 0); assertAnnaPending()
})
test('403 retry: delayed old me A, cookie B, bootstrap B, fresh me B blocks the second POST', async () => {
  let cookie = 'anna'; let meCalls = 0
  const retryMeStarted = deferred<void>(); const oldMe = deferred<Response>()
  const writes: string[] = []; const bootOwners: string[] = []; const seenMe: string[] = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) {
      meCalls++
      if (meCalls === 3) { retryMeStarted.resolve(); return oldMe.promise }
      seenMe.push(cookie); return me(cookie)
    }
    if (String(url).endsWith('/auth/antiforgery')) { bootOwners.push(cookie); return token(cookie) }
    assert.equal(options?.method, 'PUT'); writes.push(cookie)
    return json({ type: 'about:blank', title: 'CSRF', status: 403, detail: '', instance: '', code: 'invalidAntiforgery', correlationId: 'race' }, 403)
  }
  const { delivery } = beginAnna()
  const rejected = assert.rejects(delivery(), IdentityChangedError)
  await retryMeStarted.promise
  cookie = 'boris' // B login committed; broadcast has not reached this tab
  oldMe.resolve(me('anna')) // old GET was formed before the cookie switch
  await rejected
  assert.deepEqual(writes, ['anna'])
  assert.deepEqual(bootOwners, ['anna', 'boris'])
  assert.equal(seenMe.at(-1), 'boris')
  assertAnnaPending()
})
test('bootstrap response after reset cannot publish old token; Anna pending stays and Boris gets his own token', async () => {
  let cookie = 'anna'; let bootCount = 0
  const bootStarted = deferred<void>(); const oldBoot = deferred<Response>()
  const writes: { owner: string; csrf: string | null }[] = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return me(cookie)
    if (String(url).endsWith('/auth/antiforgery')) { if (++bootCount === 1) { bootStarted.resolve(); return oldBoot.promise } return token(cookie) }
    writes.push({ owner: cookie, csrf: new Headers(options?.headers).get('X-CSRF-TOKEN') }); return json({})
  }
  const { delivery } = beginAnna()
  const rejected = assert.rejects(delivery(), IdentityChangedError)
  await bootStarted.promise
  cookie = 'boris'; identityState.activate('boris'); resetTransport()
  oldBoot.resolve(token('anna')) // fetch mock deliberately ignores AbortSignal
  await rejected
  assert.equal(writes.length, 0); assertAnnaPending()
  const pendingB = captureCommand('boris', { method: 'PUT', path: '/settings', version: 'b_v1', body: { timezone: 'Europe/Berlin', weekStartsOn: 'monday', place: { id: '70000000-0000-4000-8000-000000000002', name: 'Дом Бориса' } } }, opB)
  await mutate(pendingB)
  assert.equal(bootCount, 2)
  assert.deepEqual(writes, [{ owner: 'boris', csrf: 'token-boris' }])
  assertAnnaPending()
})
test('logout checks owner after token acquisition and cannot log another cookie account out', async () => {
  let cookie = 'anna'; let logoutPosts = 0
  const started = deferred<void>(); const boot = deferred<Response>()
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return me(cookie)
    if (String(url).endsWith('/auth/antiforgery')) { started.resolve(); return boot.promise }
    if (options?.method === 'POST') logoutPosts++
    return json({})
  }
  const rejected = assert.rejects(logout('anna'), IdentityChangedError)
  await started.promise; cookie = 'boris'; boot.resolve(token('boris'))
  await rejected
  assert.equal(logoutPosts, 0)
})
test('login preparation detects cookie switch during bootstrap before posting credentials', async () => {
  identityState.activate(null)
  let cookie = 'anna'; let loginPosts = 0
  const started = deferred<void>(); const boot = deferred<Response>()
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return me(cookie)
    if (String(url).endsWith('/auth/antiforgery')) { started.resolve(); return boot.promise }
    if (options?.method === 'POST') loginPosts++
    return me('anna')
  }
  const rejected = assert.rejects(login('anna', 'test-only-password'), IdentityChangedError)
  await started.promise; cookie = 'boris'; boot.resolve(token('boris'))
  await rejected
  assert.equal(loginPosts, 0)
})
test('session restoration does not activate old me after bootstrap observes a new cookie identity', async () => {
  identityState.activate(null)
  let cookie = 'anna'
  const started = deferred<void>(); const boot = deferred<Response>()
  globalThis.fetch = async url => {
    if (String(url).endsWith('/me')) return me(cookie)
    started.resolve(); return boot.promise
  }
  const rejected = assert.rejects(restoreSession(), IdentityChangedError)
  await started.promise; cookie = 'boris'; boot.resolve(token('boris'))
  await rejected
  assert.equal(identityState.userId, null)
})

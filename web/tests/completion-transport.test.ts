import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, mutate, NetworkError, read, resetTransport, setExpiredHandler } from '../src/api/client.ts'
import { completionCommand, completionIntent } from '../src/lib/completion.ts'
import { captureCommand } from '../src/lib/operations.ts'
import { freshAfterAcknowledgement } from '../src/lib/fresh-read.ts'
import { CommandLifecycle, settleAcknowledgement } from '../src/lib/command-lifecycle.ts'
import { identityState } from '../src/state/session.ts'
import type { OccurrenceResponse } from '../src/api/types.ts'
import { completionA, completionB, occurrenceFixture, occurrenceId } from './completion-fixture.ts'

const originalFetch = globalThis.fetch
const planState = { planningInputRevision: 'input_v3', scheduleVersion: 'schedule_unchanged' }
function json(value: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } }) }
beforeEach(() => { resetTransport(); identityState.activate('anna'); setExpiredHandler(() => { identityState.activate(null); resetTransport() }) })
afterEach(() => { resetTransport(); globalThis.fetch = originalFetch; setExpiredHandler(() => undefined); identityState.clearDraft('anna', 'pending:completion-transport') })

test('lost reopen ACK safely retries A target; legacy replay incomplete never replaces fresh completed B', async () => {
  const initial = occurrenceFixture(completionA); const freshB = occurrenceFixture(completionB)
  const legacy = { ...occurrenceFixture() } as Partial<ReturnType<typeof occurrenceFixture>>
  delete legacy.completionStatus; delete legacy.completion
  const requests: { body: string; version: string | null }[] = []; const reads: string[] = []
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (path.endsWith('/me')) return json({ userId: 'anna', userName: 'anna' })
    if (path.endsWith('/auth/antiforgery')) return json({ requestToken: 'token-A', headerName: 'X-CSRF-TOKEN' })
    if (options?.method === 'POST') {
      requests.push({ body: String(options.body), version: new Headers(options.headers).get('If-Match') })
      if (requests.length === 1) throw new TypeError('Committed response lost')
      return json({ occurrence: legacy, planState }, 200, { 'Idempotency-Replayed': 'true' })
    }
    reads.push(path)
    if (path.endsWith(`/occurrences/${occurrenceId}`)) return json({ occurrence: freshB, planState })
    return json(path.includes('/calendar?') ? { blocks: [freshB.calendarBlock], occurrences: [freshB], definitions: [], planState } : { items: [freshB], nextCursor: null, planState })
  }
  const pending = captureCommand('anna', completionCommand(initial, completionIntent(initial)), '10000000-0000-4000-8000-000000000091')
  await assert.rejects(mutate(pending), NetworkError)
  const ack = await mutate(pending)
  assert.equal(ack.replayed, true)
  let cache = initial
  await freshAfterAcknowledgement(() => read<OccurrenceResponse>(`/occurrences/${occurrenceId}`), async () => { await Promise.all([read('/occurrences'), read('/calendar?from=2026-10-24T22%3A00%3A00Z&to=2026-10-25T23%3A00%3A00Z')]) }, () => identityState.userId === 'anna', result => { cache = result.occurrence })
  assert.equal(cache.completion?.id, completionB); assert.equal(cache.completionStatus, 'completed')
  assert.deepEqual(requests[0], requests[1])
  assert.equal(JSON.parse(requests[1]!.body).completionId, completionA)
  assert.ok(reads.some(path => path.includes('/calendar?'))); assert.ok(reads.includes('/api/v1/occurrences'))
})
test('401 during acknowledged completion refresh returns failure and never publishes legacy ACK as incomplete', async () => {
  const initial = occurrenceFixture(completionA)
  const lifecycle = new CommandLifecycle('anna', 'pending:completion-transport', identityState); lifecycle.mount()
  const command = captureCommand('anna', completionCommand(initial, completionIntent(initial)))
  const ticket = lifecycle.begin(command)!
  let cache = initial
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/me')) return json({ userId: 'anna', userName: 'anna' })
    if (String(url).endsWith('/auth/antiforgery')) return json({ requestToken: 'token-A', headerName: 'X-CSRF-TOKEN' })
    if (options?.method === 'POST') return json({ occurrence: { remainingWorkMinutes: 90 }, planState }, 200, { 'Idempotency-Replayed': 'true' })
    return json({ type: 'about:blank', title: 'Unauthorized', detail: '', instance: '', code: 'unauthorized', status: 401, correlationId: 'refresh' }, 401)
  }
  await mutate(command)
  const result = await settleAcknowledgement(lifecycle, ticket, async () => { await freshAfterAcknowledgement(() => read<OccurrenceResponse>(`/occurrences/${occurrenceId}`), async () => undefined, () => identityState.userId === 'anna', current => { cache = current.occurrence }) })
  assert.equal(result.success, false); assert.ok(result.refreshError instanceof ApiError)
  assert.equal(cache.completion?.id, completionA); assert.equal(identityState.userId, null)
  assert.equal(identityState.getDraft('anna', 'pending:completion-transport'), undefined)
  assert.equal(identityState.getDraft('boris', 'pending:completion-transport'), undefined)
})

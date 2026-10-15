import type { AntiforgeryResponse, MeResponse, ProblemDetails } from './types.ts'
import { assertCommandIdentity, mayUseResponse, type PendingCommand } from '../lib/operations.ts'
import { identityState } from '../state/session.ts'

export class ApiError extends Error {
  problem: ProblemDetails
  replayed: boolean
  constructor(problem: ProblemDetails, replayed = false) { super(problem.detail || problem.title); this.problem = problem; this.replayed = replayed }
}
export class NetworkError extends Error {}
export class IdentityChangedError extends Error {}
export interface ApiResult<T> { data: T; etag: string | null; replayed: boolean }
interface TransportStamp { generation: number; epoch: number; userId: string | null }
let transportGeneration = 0
let csrf: { token: string; stamp: TransportStamp } | null = null
let expired: () => void = () => undefined
const controllers = new Set<AbortController>()
export function setExpiredHandler(handler: () => void) { expired = handler }
export function resetTransport() {
  transportGeneration++
  csrf = null
  for (const controller of controllers) controller.abort()
  controllers.clear()
}
function transportStamp(): TransportStamp { return { generation: transportGeneration, epoch: identityState.epoch, userId: identityState.userId } }
function isCurrentTransport(stamp: TransportStamp) { return stamp.generation === transportGeneration && stamp.epoch === identityState.epoch && stamp.userId === identityState.userId }
function assertTransport(stamp: TransportStamp) { if (!isCurrentTransport(stamp)) throw new IdentityChangedError('Сеанс изменился во время подготовки запроса. Ввод сохранён для исходного аккаунта.') }
function identityMismatch(stamp: TransportStamp): never {
  if (isCurrentTransport(stamp)) expired()
  throw new IdentityChangedError('Аккаунт изменился. Ввод сохранён для исходного аккаунта.')
}
async function raw<T>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, expireOnUnauthorized = true): Promise<ApiResult<T>> {
  const stamp = transportStamp()
  const controller = new AbortController()
  controllers.add(controller)
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json, application/problem+json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const payload: unknown = response.status === 204 ? undefined : await response.json()
    const replayed = response.headers.get('Idempotency-Replayed') === 'true'
    if (!response.ok) {
      const problem = payload as ProblemDetails
      if (!problem || typeof problem.code !== 'string') throw new NetworkError('Получен неожиданный ответ сервера. Обновите данные или повторите отправку.')
      if (response.status === 401 && path !== '/auth/login' && expireOnUnauthorized && isCurrentTransport(stamp)) expired()
      throw new ApiError(problem, replayed)
    }
    return { data: payload as T, etag: response.headers.get('ETag'), replayed }
  } catch (error) {
    if (error instanceof ApiError || error instanceof NetworkError) throw error
    throw new NetworkError('Ответ не получен. Ввод сохранён; повтор отправит ту же операцию без дублирования.')
  } finally { clearTimeout(timeout); controllers.delete(controller) }
}
export async function bootstrapCsrf(stamp = transportStamp()) {
  assertTransport(stamp)
  const result = await raw<AntiforgeryResponse>('/auth/antiforgery')
  assertTransport(stamp)
  if (result.data.headerName !== 'X-CSRF-TOKEN' || typeof result.data.requestToken !== 'string' || !result.data.requestToken) throw new NetworkError('Сервер вернул неподдерживаемую защиту сеанса.')
  csrf = { token: result.data.requestToken, stamp }
  return csrf.token
}
async function acquireToken(stamp: TransportStamp) {
  assertTransport(stamp)
  const token = csrf && isCurrentTransport(csrf.stamp) ? csrf.token : await bootstrapCsrf(stamp)
  assertTransport(stamp)
  return token
}
export async function getMe() { return (await raw<MeResponse>('/me')).data }
async function optionalIdentity() {
  try { return (await raw<MeResponse>('/me', 'GET', undefined, {}, false)).data.userId } catch (error) { if (error instanceof ApiError && error.problem.status === 401) return null; throw error }
}
export async function restoreSession(expectedUserId?: string) {
  const stamp = transportStamp()
  const before = await getMe()
  assertTransport(stamp)
  if (expectedUserId && before.userId !== expectedUserId) identityMismatch(stamp)
  await acquireToken(stamp)
  assertTransport(stamp)
  const after = await getMe()
  assertTransport(stamp)
  if (after.userId !== before.userId || (expectedUserId && after.userId !== expectedUserId)) identityMismatch(stamp)
  return after
}
async function sendOwned<T>(path: string, method: string, body: unknown, stamp: TransportStamp, owner: string, version?: string, beforeDispatch?: () => void) {
  assertTransport(stamp)
  if (stamp.userId !== owner) identityMismatch(stamp)
  const before = await getMe()
  assertTransport(stamp)
  if (before.userId !== owner) identityMismatch(stamp)
  const token = await acquireToken(stamp)
  assertTransport(stamp)
  // Cookie identity must be checked after token acquisition. Broadcast delivery
  // alone cannot protect the interval spent awaiting bootstrap.
  const current = await getMe()
  assertTransport(stamp)
  if (current.userId !== owner) identityMismatch(stamp)
  const headers: Record<string, string> = { 'X-CSRF-TOKEN': token, ...(version ? { 'If-Match': `"${version}"` } : {}) }
  // No await between this final synchronous guard and raw's fetch dispatch.
  assertTransport(stamp)
  beforeDispatch?.()
  return raw<T>(path, method, body, headers)
}
export async function login(userName: string, password: string) {
  resetTransport()
  const stamp = transportStamp()
  const before = await optionalIdentity()
  assertTransport(stamp)
  const token = await acquireToken(stamp)
  assertTransport(stamp)
  const after = await optionalIdentity()
  assertTransport(stamp)
  if (after !== before) identityMismatch(stamp)
  const headers = { 'X-CSRF-TOKEN': token }
  assertTransport(stamp)
  const result = await raw<MeResponse>('/auth/login', 'POST', { userName, password }, headers)
  assertTransport(stamp)
  resetTransport()
  return restoreSession(result.data.userId)
}
export async function logout(userId: string) {
  const stamp = transportStamp()
  await sendOwned<void>('/auth/logout', 'POST', undefined, stamp, userId)
  assertTransport(stamp)
  resetTransport()
  const anonymousStamp = transportStamp()
  if (await optionalIdentity() !== null) identityMismatch(anonymousStamp)
  assertTransport(anonymousStamp)
  await acquireToken(anonymousStamp)
  assertTransport(anonymousStamp)
  if (await optionalIdentity() !== null) identityMismatch(anonymousStamp)
  assertTransport(anonymousStamp)
}
export async function read<T>(path: string): Promise<T> {
  const epoch = identityState.epoch
  const owner = identityState.userId
  if (!owner) throw new IdentityChangedError('Войдите в аккаунт.')
  const result = await raw<T>(path)
  if (!mayUseResponse(epoch, identityState.epoch, owner, identityState.userId)) throw new IdentityChangedError('Сеанс изменился. Ответ прежнего аккаунта скрыт.')
  // A cookie may change without BroadcastChannel (or before delivery). Keep the
  // private payload out of the cache until the server confirms this identity.
  const current = await getMe()
  if (!mayUseResponse(epoch, identityState.epoch, owner, identityState.userId)) throw new IdentityChangedError('Сеанс изменился. Ответ прежнего аккаунта скрыт.')
  if (current.userId !== owner) { expired(); throw new IdentityChangedError('Аккаунт изменился. Данные скрыты, ввод сохранён для исходного аккаунта.') }
  return result.data
}
export async function mutate(command: PendingCommand, beforeDispatch?: () => void) {
  assertCommandIdentity(command, identityState.userId)
  const stamp = transportStamp()
  const send = () => sendOwned<unknown>(command.path, command.method, command.body, stamp, command.userId, command.version, beforeDispatch)
  let result: ApiResult<unknown>
  try { result = await send() } catch (error) {
    if (!(error instanceof ApiError) || error.problem.code !== 'invalidAntiforgery') throw error
    assertTransport(stamp)
    csrf = null
    result = await send()
  }
  assertTransport(stamp)
  return result
}

import { openStorage, type DraftRecord, type StoragePort } from '../src/persistence/database.ts'
import { freezePending } from '../src/sync/runtime.ts'
import { captureCommand } from '../src/lib/operations.ts'

const button = document.querySelector<HTMLButtonElement>('#run')!
const results = document.querySelector<HTMLOListElement>('#results')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function nativeOpen(name: string, version: number, upgrade?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((ok, fail) => { const request = indexedDB.open(name, version); request.onupgradeneeded = () => upgrade?.(request.result); request.onsuccess = () => ok(request.result); request.onerror = () => fail(request.error) })
}
async function reject(action: () => Promise<unknown>) { let failed = false; try { await action() } catch { failed = true }; check(failed, 'Ожидался явный отказ, но операция была принята') }
button.addEventListener('click', async () => {
  button.disabled = true; results.replaceChildren(); status.textContent = 'Выполняются native транзакции…'
  const prefix = `Vibe.S1.tests.${crypto.randomUUID()}`
  const connections: StoragePort[] = []
  let passed = 0, failed = 0
  const run = async (name: string, action: () => Promise<void>) => { const li = document.createElement('li'); try { await action(); li.textContent = `PASS — ${name}`; passed++ } catch (error) { li.textContent = `FAIL — ${name}: ${error instanceof Error ? error.message : String(error)}`; li.className = 'fail'; failed++ }; results.append(li) }
  const open = async (suffix = '') => { const connection = await openStorage(prefix + suffix); connections.push(connection); return connection }
  const user = 'native-test-account'
  const draft: DraftRecord = { userId: user, draftId: crypto.randomUUID(), key: 'settings', value: { name: 'Первая редакция' }, base: { serverVersion: 'base_1' }, revision: 1, updatedAt: Date.now() }
  const make = () => freezePending(captureCommand(user, { method: 'PUT', path: '/settings', body: { timezone: 'UTC' }, version: 'base_1' }), draft, crypto.randomUUID())
  let first: Awaited<ReturnType<typeof open>>, second: Awaited<ReturnType<typeof open>>
  await run('Два connection: атомарная резервация оставляет ровно одну отправку', async () => {
    first = await open(); second = await open()
    const a = make(), b = make()
    const won = await Promise.all([first.reserve(a, draft), second.reserve(b, draft)])
    check(won.filter(Boolean).length === 1, 'CAS допустил две отправки')
    check((await second.drafts(user)).length === 1, 'Черновик не сохранён вместе с отправкой')
  })
  await run('Commit-before-fetch/crash: после reopen исходные данные доступны до отправки', async () => {
    const frozen = await first!.getPending(user); check(frozen, 'Нет frozen отправки')
    first!.close(); first = await open()
    const restored = await first.getPending(user)
    check(restored?.opId === frozen.opId && restored.ifMatch === '"base_1"', 'Crash изменил отправку')
    check(restored.status === 'unconfirmed', 'Неотправленная запись ошибочно завершена')
  })
  await run('ACK/reopen: поздний failure не понижает status; новая revision ввода переживает cleanup', async () => {
    const pending = (await first!.getPending(user))!
    await second!.saveDraft({ ...draft, value: { name: 'Более новый ввод' }, revision: 2 })
    check(await first!.transition(pending, { status: 'acknowledgedRefresh' }), 'ACK не записан')
    check(!await second!.transition(pending, { status: 'rejected' }), 'Старый failure понизил ACK')
    first!.close(); first = await open()
    const ack = (await first.getPending(user))!
    check(ack.status === 'acknowledgedRefresh', 'Crash потерял ACK состояние')
    check(await first.transition(ack, null, true), 'Не удалось освободить ACK slot')
    check((await second!.drafts(user))[0]?.revision === 2, 'ACK удалил более новый ввод')
    const next = make(); check(await second!.reserve(next, { ...draft, revision: 2 }), 'Новый slot не создан')
    check(!await first.transition(ack, null, true), 'Поздний ACK удалил новый slot')
    check((await first.getPending(user))?.opId === next.opId, 'Новая отправка потеряна')
    await reject(() => first.clearAccount(user))
  })
  await run('Namespace аккаунта и очистка только после разрешения slot', async () => {
    check((await first!.drafts('another-account')).length === 0, 'Утечка черновика другого аккаунта')
    const pending = (await first!.getPending(user))!
    check(await first!.transition(pending, { status: 'rejected' }), 'Отказ не записан')
    const rejected = (await first!.getPending(user))!
    check(await first!.transition(rejected, null), 'Отказ не разрешён')
    await first!.clearAccount(user)
    check((await second!.drafts(user)).length === 0, 'Черновики не очищены')
  })
  await run('Будущая версия: failed open не удаляет store и допускает новое открытие после устранения причины', async () => {
    const name = prefix + '.future'
    const future = await nativeOpen(name, 2, db => db.createObjectStore('sentinel')); future.close()
    await reject(() => openStorage(name))
    const stillThere = await nativeOpen(name, 2)
    check(stillThere.objectStoreNames.contains('sentinel'), 'Отказ удалил данные новой версии'); stillThere.close()
    // A separate transient factory open failure is injected before using the
    // real factory again; no production database or deletion is involved.
    const failing = { open: () => { throw new DOMException('Privacy mode test', 'SecurityError') } } as unknown as IDBFactory
    await reject(() => openStorage(prefix + '.recover', failing))
    const recovered = await open('.recover'); await recovered.saveDraft(draft)
    check((await recovered.drafts(user)).length === 1, 'Повторное открытие после отказа не сработало')
  })
  await run('Native upgrade abort сохраняет прежнюю версию и данные', async () => {
    const name = prefix + '.upgrade'
    const original = await nativeOpen(name, 1, db => db.createObjectStore('sentinel')); original.close()
    await new Promise<void>((ok, fail) => { const request = indexedDB.open(name, 2); request.onupgradeneeded = () => { request.result.createObjectStore('must-rollback'); request.transaction!.abort() }; request.onerror = () => ok(); request.onsuccess = () => { request.result.close(); fail(new Error('Upgrade не был отменён')) } })
    const preserved = await nativeOpen(name, 1)
    check(preserved.objectStoreNames.contains('sentinel') && !preserved.objectStoreNames.contains('must-rollback'), 'Upgrade не откатился атомарно'); preserved.close()
  })
  await run('Native blocked upgrade: adapter явно отказывает, новое открытие после закрытия blocker успешно', async () => {
    const name = prefix + '.blocked'
    const held = await nativeOpen(name, 1, db => { db.createObjectStore('drafts', { keyPath: ['userId', 'draftId'] }); db.createObjectStore('pending', { keyPath: 'userId' }) })
    held.onversionchange = () => undefined // This connection deliberately holds the upgrade.
    // The factory requests v2 only inside this isolated harness, so native IDB
    // can exercise onblocked in the actual v1 adapter without changing prod DB.
    const upgrading = { open: (databaseName: string) => indexedDB.open(databaseName, 2) } as unknown as IDBFactory
    try { await reject(() => openStorage(name, upgrading)) } finally { held.close() }
    const recovered = await openStorage(name, upgrading); connections.push(recovered)
    await recovered.saveDraft(draft)
    check((await recovered.drafts(user)).length === 1, 'После blocker хранилище не восстановилось')
  })
  for (const connection of connections) connection.close()
  for (const suffix of ['', '.future', '.recover', '.upgrade', '.blocked']) { const name = prefix + suffix; if (name.startsWith('Vibe.S1.tests.')) indexedDB.deleteDatabase(name) }
  status.textContent = `Завершено: ${passed} PASS, ${failed} FAIL. Реальный IndexedDB; тестовая база ${prefix}.`
  button.disabled = false
})

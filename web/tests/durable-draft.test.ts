import test from 'node:test'
import assert from 'node:assert/strict'
import { openEditorDraft, sameData, selectRestoration } from '../src/lib/durable-draft.ts'
import { MemoryStorage } from './storage-memory.ts'
import type { DraftRecord } from '../src/persistence/database.ts'

test('restored baseline equals unchanged server DTO despite JSONB property order', () => {
  const stored = { serverVersion: 'CaSe_V1', timezone: 'Europe/Berlin', place: { id: 'a', name: 'Дом', serverVersion: 'place_1' }, availability: [{ days: ['monday', 'tuesday'], window: { from: '09:00', to: '18:00' } }] }
  const fresh = { availability: [{ window: { to: '18:00', from: '09:00' }, days: ['monday', 'tuesday'] }], place: { serverVersion: 'place_1', name: 'Дом', id: 'a' }, timezone: 'Europe/Berlin', serverVersion: 'CaSe_V1' }
  assert.notEqual(JSON.stringify(stored), JSON.stringify(fresh))
  assert.equal(sameData(stored, fresh), true)
  assert.equal(sameData(stored, { ...fresh, serverVersion: 'case_v1' }), false)
  assert.equal(sameData(stored, { ...fresh, place: { ...fresh.place, name: 'Другое место' } }), false)
  assert.equal(sameData(stored, { ...fresh, availability: [{ ...fresh.availability[0], days: ['tuesday', 'monday'] }] }), false)
  assert.equal(sameData(undefined, undefined), true)
  assert.equal(sameData(undefined, null), false)
  assert.equal(sameData({ a: undefined }, {}), false)
})
test('select submitted A then newer B of one draft remounts chosen revision and keeps separately edited copies', async () => {
  const storage = new MemoryStorage()
  for (const key of ['settings', 'new-category', 'new-definition', 'definition:task', 'create-occurrence:task', 'occurrence:task', 'placement:task']) {
    const submitted: DraftRecord = { userId: 'anna', draftId: crypto.randomUUID(), key, value: { name: 'Отправлено A' }, base: { serverVersion: 'v1' }, revision: 1, updatedAt: 1 }
    const newer = { ...submitted, value: { name: 'Новый ввод B' }, base: { serverVersion: 'v2' }, revision: 3, updatedAt: 3 }
    await storage.saveDraft(newer)
    const a = selectRestoration(submitted)
    const openedA = openEditorDraft('anna', key, {}, {}, a.record)
    const continuedA = { ...openedA, revision: 2, value: { name: 'Правка копии A' } }
    await storage.saveDraft(continuedA)
    const b = selectRestoration(newer)
    // App uses this selection token as the React key for every restored form;
    // initial-only state therefore initializes from B, even with the same id.
    assert.notEqual(a.editorKey, b.editorKey)
    const openedB = openEditorDraft('anna', key, {}, {}, b.record)
    assert.deepEqual(openedB.value, { name: 'Новый ввод B' })
    assert.deepEqual(openedB.base, { serverVersion: 'v2' })
    assert.notEqual(openedB.draftId, openedA.draftId)
    await storage.saveDraft(openedB)
    const saved = await storage.drafts('anna')
    assert.deepEqual(saved.find(row => row.draftId === newer.draftId), newer)
    assert.deepEqual(saved.find(row => row.draftId === continuedA.draftId)?.value, { name: 'Правка копии A' })
    assert.deepEqual(submitted.value, { name: 'Отправлено A' })
    assert.notEqual(selectRestoration(newer).editorKey, b.editorKey)
  }
})

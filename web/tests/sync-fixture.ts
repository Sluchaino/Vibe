import type { BootstrapPage, ChangesPage, SyncItem, TaskDefinition } from '../src/api/types.ts'
import { occurrenceFixture } from './completion-fixture.ts'
export const stream = '10000000-0000-4000-8000-000000000001'
export const snapshot = '10000000-0000-4000-8000-000000000002'
export const plan = { planningInputRevision: 'input_1', scheduleVersion: 'schedule_1' }
export function items(): SyncItem[] {
  const occurrence = occurrenceFixture()
  const definition: TaskDefinition = { id: occurrence.definitionId, title: 'Название', description: '', categoryId: null, importance: 'high', difficulty: 'heavy', executionPriority: 4, ...occurrence.constraintsSnapshot, serverVersion: 'definition_v1' }
  return [{ kind: 'settings', value: { timezone: 'Europe/Berlin', weekStartsOn: 'monday', place: { id: occurrence.constraintsSnapshot.placeId, name: 'Дом', serverVersion: 'place_1' }, serverVersion: 'settings_1' } }, { kind: 'definition', value: definition }, { kind: 'occurrence', value: occurrence }]
}
export function bootstrap(overrides: Partial<BootstrapPage> = {}): BootstrapPage { return { protocol: 's1', streamId: stream, snapshotId: snapshot, expiresAt: '2026-10-15T12:15:00.000Z', asOfCursor: 'after-snapshot', planState: plan, items: items(), nextPageCursor: null, ...overrides } }
export function delta(overrides: Partial<ChangesPage> = {}): ChangesPage { return { protocol: 's1', streamId: stream, changes: [], nextCursor: 'tail', hasMore: false, ...overrides } }
export function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }

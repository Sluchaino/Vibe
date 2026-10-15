import { createContext, useContext, useSyncExternalStore } from 'react'
import type { DraftRecord } from '../persistence/database.ts'
import type { AccountRuntime } from './runtime.ts'
export const RuntimeContext = createContext<{ runtime: AccountRuntime; restore: DraftRecord | null; restoreKey: string }>({ runtime: null as unknown as AccountRuntime, restore: null, restoreKey: '' })
export function useRuntime() { const context = useContext(RuntimeContext); if (!context.runtime) throw new Error('Не подключён аккаунт.'); return context }
export function useSyncState() { const { runtime } = useRuntime(); return useSyncExternalStore(runtime.coordinator.subscribe, runtime.coordinator.snapshot) }
export function useLocalState() { const { runtime } = useRuntime(); return useSyncExternalStore(runtime.subscribe, runtime.snapshot) }
// Existing conflict forms obtain an explicit fresh comparison from the same
// confirmed projection; direct entity GET responses never enter the shadow.
export async function confirmedRead<T>(runtime: AccountRuntime, path: string): Promise<T> {
  await runtime.coordinator.catchUp()
  const state = runtime.coordinator.snapshot().projection!
  if (path === '/settings') return { settings: state.settings, planState: state.planState } as T
  const id = path.split('/').at(-1)!
  if (path.startsWith('/task-definitions/')) { const definition = state.definitions.get(id); if (!definition) throw new Error('Задача больше недоступна.'); return { definition, planState: state.planState } as T }
  if (path.startsWith('/occurrences/')) { const occurrence = state.occurrences.get(id); if (!occurrence) throw new Error('Выполнение больше недоступно.'); return { occurrence, planState: state.planState } as T }
  throw new Error('Неизвестная запись.')
}

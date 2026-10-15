import type { CalendarResponse, Category, PlanState, SyncItem, TaskDefinition, TaskOccurrence, UserSettings } from '../api/types.ts'
import { hasCurrentCompletion } from '../lib/completion.ts'
import { intersects } from '../lib/time.ts'
import { normalizeReceived, SyncSchemaError } from './validation.ts'

export interface Projection { settings: UserSettings | null; categories: ReadonlyMap<string, Category>; definitions: ReadonlyMap<string, TaskDefinition>; occurrences: ReadonlyMap<string, TaskOccurrence>; planState: PlanState; cursor: string; streamId: string; generation: number }
export function emptyProjection(planState: PlanState, cursor: string, streamId: string, generation: number): Projection { return { settings: null, categories: new Map(), definitions: new Map(), occurrences: new Map(), planState, cursor, streamId, generation } }
export function replaceItems(state: Projection, items: SyncItem[], planState: PlanState, cursor: string): Projection {
  const next = { ...state, categories: new Map(state.categories), definitions: new Map(state.definitions), occurrences: new Map(state.occurrences), planState, cursor, generation: state.generation + 1 }
  for (const item of normalizeReceived(items)) {
    if (item.kind === 'settings') next.settings = item.value
    else if (item.kind === 'category') next.categories.set(item.value.id, item.value)
    else if (item.kind === 'definition') next.definitions.set(item.value.id, item.value)
    else next.occurrences.set(item.value.id, item.value)
  }
  return next
}
export function validateProjection(state: Projection) {
  if (!state.settings) throw new SyncSchemaError()
  for (const definition of state.definitions.values()) if ((definition.categoryId && !state.categories.has(definition.categoryId)) || definition.placeId !== state.settings.place?.id) throw new SyncSchemaError()
  const blockIds = new Set<string>(), completionIds = new Set<string>()
  for (const occurrence of state.occurrences.values()) {
    const block = occurrence.calendarBlock, completion = occurrence.completion
    if (!state.definitions.has(occurrence.definitionId) || occurrence.constraintsSnapshot.placeId !== state.settings.place?.id || !hasCurrentCompletion(occurrence) || (occurrence.placementStatus === 'planned') !== !!block) throw new SyncSchemaError()
    if (block) {
      if (block.occurrenceId !== occurrence.id || block.startInstant >= block.endInstant || blockIds.has(block.id)) throw new SyncSchemaError()
      blockIds.add(block.id)
    }
    if (completion) { if (completion.occurrenceId !== occurrence.id || completionIds.has(completion.id)) throw new SyncSchemaError(); completionIds.add(completion.id) }
  }
}
export function sorted<T extends { id: string }>(values: Iterable<T>): T[] { return [...values].sort((a, b) => a.id.localeCompare(b.id)) }
export function selectOccurrences(state: Projection, completion: 'all' | 'completed' | 'incomplete', definitionId?: string, unplanned = false) {
  return sorted(state.occurrences.values()).filter(item => (!definitionId || item.definitionId === definitionId) && (completion === 'all' || item.completionStatus === completion) && (!unplanned || item.placementStatus === 'unplanned'))
}
export function pageItems<T>(items: T[], count: number) { return { items: items.slice(0, count), hasMore: items.length > count } }
export function selectCalendar(state: Projection, from: string, to: string): CalendarResponse {
  const occurrences = sorted(state.occurrences.values()).filter(item => item.calendarBlock && intersects(item.calendarBlock.startInstant, item.calendarBlock.endInstant, from, to))
  return { from, to, occurrences, blocks: occurrences.map(item => item.calendarBlock!), definitions: sorted(state.definitions.values()), planState: state.planState }
}

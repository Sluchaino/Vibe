import type { ActiveCompletion, TaskOccurrence } from '../src/api/types.ts'
export const occurrenceId = '80000000-0000-4000-8000-000000000001'
export const completionA = '90000000-0000-4000-8000-000000000001'
export const completionB = '90000000-0000-4000-8000-000000000002'
export function occurrenceFixture(activeId: string | null = null, planned = true): TaskOccurrence {
  const completion: ActiveCompletion | null = activeId ? { id: activeId, occurrenceId, completedAt: '2026-10-14T10:15:42.123Z', revokedAt: null, source: 'manual', serverVersion: 'fact_v1' } : null
  return { id: occurrenceId, definitionId: '70000000-0000-4000-8000-000000000001', logicalDate: '2026-10-25', sourceDefinitionVersion: 'definition_v1', constraintsSnapshot: { durationPolicy: { mode: 'fixedWork', requiredWorkMinutes: 90 }, splitAllowed: false, mobilityPolicy: 'fixedAfterPlacement', availabilityRules: { timezone: 'Europe/Berlin', windows: [], dateExceptions: [] }, placeId: '60000000-0000-4000-8000-000000000001', requiredRestMinutes: 0 }, remainingWorkMinutes: completion ? 0 : 90, placementStatus: planned ? 'planned' : 'unplanned', calendarBlock: planned ? { id: '50000000-0000-4000-8000-000000000001', occurrenceId, kind: 'task', startInstant: '2026-10-25T00:30:00Z', endInstant: '2026-10-25T02:00:00Z', fixed: true, serverVersion: 'block_unchanged' } : null, serverVersion: activeId === completionB ? 'occ_v3' : completion ? 'occ_v2' : 'occ_v1', completionStatus: completion ? 'completed' : 'incomplete', completion }
}

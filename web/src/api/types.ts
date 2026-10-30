// Wire types from contracts/d1.openapi.json. Versions are opaque equality tokens.
export type Version = string
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
export type MobilityPolicy = 'movable' | 'fixedAfterPlacement'
export interface FixedWorkDuration { mode: 'fixedWork'; requiredWorkMinutes: number }
export type WorkOrigin = 'manual' | 'interval' | 'unspecified'
export type DstDisambiguation = 'earlier' | 'later' | null
export interface TimeIntent { timezone: string; startLocalTime: string | null; endLocalTime: string | null; endDayOffset: number; startDisambiguation: DstDisambiguation; endDisambiguation: DstDisambiguation }
export interface ResolvedTiming { startInstant: string; endInstant: string }
export type PlacementIssue = 'invalidLocalTime' | 'ambiguousLocalTime' | 'workMismatch' | 'placementConflict' | 'outsideAvailability' | 'outOfRange'
export interface AvailabilityWindow { daysOfWeek: DayOfWeek[]; startLocalTime: string; endLocalTime: string; endDayOffset: 0 | 1 }
export interface ExceptionWindow { startLocalTime: string; endLocalTime: string; endDayOffset: 0 | 1; startUtcOffset: string; endUtcOffset: string }
export interface AvailabilityDateException { localDate: string; windows: ExceptionWindow[] }
export interface AvailabilityRules { timezone: string; windows: AvailabilityWindow[]; dateExceptions: AvailabilityDateException[] }
export interface ConstraintsSnapshot {
  durationPolicy: FixedWorkDuration | null
  workOrigin: WorkOrigin
  splitAllowed: false
  mobilityPolicy: MobilityPolicy
  availabilityRules: AvailabilityRules
  placeId: string
  requiredRestMinutes: 0
}
export interface DefinitionFields extends ConstraintsSnapshot {
  title: string
  description: string
  categoryId: string | null
  importance: 'low' | 'normal' | 'high'
  difficulty: 'light' | 'medium' | 'heavy'
  executionPriority: number
}
export interface TaskDefinition extends DefinitionFields { id: string; serverVersion: Version }
export interface Place { id: string; name: string; serverVersion: Version }
export interface PlaceInput { id: string; name: string }
export interface UserSettings { timezone: string; weekStartsOn: 'monday'; place: Place | null; serverVersion: Version }
export interface Category { id: string; name: string; serverVersion: Version }
export interface CalendarBlock { id: string; occurrenceId: string; kind: 'task'; startInstant: string; endInstant: string; fixed: boolean; serverVersion: Version }
export interface Completion { id: string; occurrenceId: string; completedAt: string; revokedAt: string | null; source: 'manual'; serverVersion: Version }
export interface ActiveCompletion extends Completion { revokedAt: null }
export type CompletionStatus = 'incomplete' | 'completed'
export interface TaskOccurrence {
  id: string
  definitionId: string
  logicalDate: string | null
  sourceDefinitionVersion: Version
  constraintsSnapshot: ConstraintsSnapshot
  remainingWorkMinutes: number | null
  placementStatus: 'unplanned' | 'planned'
  calendarBlock: CalendarBlock | null
  serverVersion: Version
  completionStatus: CompletionStatus
  completion: ActiveCompletion | null
  timeIntent: TimeIntent | null
  resolvedTiming: ResolvedTiming | null
  placementIssue: PlacementIssue | null
}
export type TaskOccurrenceLegacyC1 = Omit<TaskOccurrence, 'timeIntent' | 'resolvedTiming' | 'placementIssue' | 'logicalDate' | 'remainingWorkMinutes' | 'constraintsSnapshot'> & { logicalDate: string; remainingWorkMinutes: number; constraintsSnapshot: Omit<ConstraintsSnapshot, 'workOrigin' | 'durationPolicy'> & { durationPolicy: FixedWorkDuration } }
export type TaskOccurrenceLegacyD1 = Omit<TaskOccurrenceLegacyC1, 'completionStatus' | 'completion'>
export interface PlanState { planningInputRevision: Version; scheduleVersion: Version }
interface RecurrenceBase { id: string; definitionId: string; timezone: string; startDate: string; endDate: string | null; enabled: boolean; generatedThrough: string | null; serverVersion: Version; timeIntent: TimeIntent | null }
export type RecurrenceRule = RecurrenceBase & ({ pattern: 'weekly'; daysOfWeek: DayOfWeek[] } | { pattern: 'interval'; intervalDays: number; anchorDate: string })
export interface RecurrenceResponse { rule: RecurrenceRule; planState: PlanState }
export type CreateRecurrenceRuleRequest = { opId: string; id: string; definitionVersion: Version; timezone: string; startDate: string; endDate: string | null; timeIntent: TimeIntent | null } & ({ pattern: 'weekly'; daysOfWeek: DayOfWeek[] } | { pattern: 'interval'; intervalDays: number; anchorDate: string })
export interface StopRecurrenceRuleRequest { opId: string }
export type SyncItem = { kind: 'settings'; value: UserSettings } | { kind: 'category'; value: Category } | { kind: 'definition'; value: TaskDefinition } | { kind: 'occurrence'; value: TaskOccurrence } | { kind: 'recurrence'; value: RecurrenceRule }
export interface BootstrapPage { protocol: 's3'; streamId: string; snapshotId: string; expiresAt: string; asOfCursor: string; planState: PlanState; items: SyncItem[]; nextPageCursor: string | null }
export interface SyncChange { id: string; opId: string; item: SyncItem; planState: PlanState }
export interface ChangesPage { protocol: 's3'; streamId: string; changes: SyncChange[]; nextCursor: string; hasMore: boolean }
export interface SettingsResponse { settings: UserSettings; planState: PlanState }
export interface DefinitionResponse { definition: TaskDefinition; planState: PlanState }
export interface CategoryResponse { category: Category; planState: PlanState }
export interface OccurrenceResponse { occurrence: TaskOccurrence; planState: PlanState }
export type OccurrenceMutationResponse = OccurrenceResponse | { occurrence: TaskOccurrenceLegacyC1 | TaskOccurrenceLegacyD1; planState: PlanState }
export interface Page<T> { items: T[]; nextCursor: string | null; planState: PlanState }
export interface CalendarResponse { from: string; to: string; blocks: CalendarBlock[]; occurrences: TaskOccurrence[]; definitions: TaskDefinition[]; planState: PlanState }
export interface MeResponse { userId: string; userName: string }
export interface AntiforgeryResponse { requestToken: string; headerName: 'X-CSRF-TOKEN' }
export interface UpdateSettingsRequest { opId: string; timezone: string; weekStartsOn: 'monday'; place: PlaceInput }
export interface CreateCategoryRequest { opId: string; id: string; name: string }
export interface CreateDefinitionRequest extends DefinitionFields { opId: string; id: string }
export interface UpdateDefinitionRequest extends DefinitionFields { opId: string }
export interface CreateOccurrenceRequest { opId: string; id: string; definitionVersion: Version; logicalDate: string | null; timeIntent: TimeIntent | null }
export interface UpdateOccurrenceRequest { opId: string; logicalDate: string | null; constraintsSnapshot: ConstraintsSnapshot; timeIntent: TimeIntent | null; allowFixedChange: boolean }
export interface CompleteOccurrenceRequest { opId: string }
export interface ReopenOccurrenceRequest { opId: string; completionId: string }
interface PlacementBase { opId: string; baseScheduleVersion: Version; allowFixedChange: boolean }
export type PlacementCommand =
  | (PlacementBase & { action: 'place' | 'move'; localStart: string; timezone: string; utcOffset: string })
  | (PlacementBase & { action: 'unplace' })
  | (PlacementBase & { action: 'setFixed'; fixed: boolean })
export interface ProblemDetails {
  type: string; title: string; status: number; detail: string; instance: string; code: string; correlationId: string
  fieldErrors?: Record<string, string[]>
  currentServerVersion?: Version
  currentPlanState?: PlanState
  currentSettings?: UserSettings
  currentDefinition?: TaskDefinition
  currentOccurrence?: TaskOccurrence | TaskOccurrenceLegacyC1 | TaskOccurrenceLegacyD1
  conflictingBlockIds?: string[]
  validUtcOffsets?: string[]
}

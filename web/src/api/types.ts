// Wire types from contracts/d1.openapi.json. Versions are opaque equality tokens.
export type Version = string
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
export type MobilityPolicy = 'movable' | 'fixedAfterPlacement'
export interface FixedWorkDuration { mode: 'fixedWork'; requiredWorkMinutes: number }
export interface AvailabilityWindow { daysOfWeek: DayOfWeek[]; startLocalTime: string; endLocalTime: string; endDayOffset: 0 | 1 }
export interface ExceptionWindow { startLocalTime: string; endLocalTime: string; endDayOffset: 0 | 1; startUtcOffset: string; endUtcOffset: string }
export interface AvailabilityDateException { localDate: string; windows: ExceptionWindow[] }
export interface AvailabilityRules { timezone: string; windows: AvailabilityWindow[]; dateExceptions: AvailabilityDateException[] }
export interface ConstraintsSnapshot {
  durationPolicy: FixedWorkDuration
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
export interface TaskOccurrence {
  id: string
  definitionId: string
  logicalDate: string
  sourceDefinitionVersion: Version
  constraintsSnapshot: ConstraintsSnapshot
  remainingWorkMinutes: number
  placementStatus: 'unplanned' | 'planned'
  calendarBlock: CalendarBlock | null
  serverVersion: Version
}
export interface PlanState { planningInputRevision: Version; scheduleVersion: Version }
export interface SettingsResponse { settings: UserSettings; planState: PlanState }
export interface DefinitionResponse { definition: TaskDefinition; planState: PlanState }
export interface CategoryResponse { category: Category; planState: PlanState }
export interface OccurrenceResponse { occurrence: TaskOccurrence; planState: PlanState }
export interface Page<T> { items: T[]; nextCursor: string | null; planState: PlanState }
export interface CalendarResponse { from: string; to: string; blocks: CalendarBlock[]; occurrences: TaskOccurrence[]; definitions: TaskDefinition[]; planState: PlanState }
export interface MeResponse { userId: string; userName: string }
export interface AntiforgeryResponse { requestToken: string; headerName: 'X-CSRF-TOKEN' }
export interface UpdateSettingsRequest { opId: string; timezone: string; weekStartsOn: 'monday'; place: PlaceInput }
export interface CreateCategoryRequest { opId: string; id: string; name: string }
export interface CreateDefinitionRequest extends DefinitionFields { opId: string; id: string }
export interface UpdateDefinitionRequest extends DefinitionFields { opId: string }
export interface CreateOccurrenceRequest { opId: string; id: string; definitionVersion: Version; logicalDate: string }
export interface UpdateOccurrenceRequest { opId: string; logicalDate: string; constraintsSnapshot: ConstraintsSnapshot; allowFixedChange: boolean }
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
  currentOccurrence?: TaskOccurrence
  conflictingBlockIds?: string[]
  validUtcOffsets?: string[]
}

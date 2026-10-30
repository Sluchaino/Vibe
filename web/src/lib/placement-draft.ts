import type { TaskOccurrence } from '../api/types.ts'
import { localParts } from './time.ts'

export function initialPlacementStart(occurrence: Pick<TaskOccurrence, 'logicalDate' | 'calendarBlock'> & Partial<Pick<TaskOccurrence, 'timeIntent' | 'resolvedTiming'>>, timezone: string) {
  const instant = occurrence.calendarBlock?.startInstant ?? occurrence.resolvedTiming?.startInstant
  if (instant) { const parts = localParts(instant, timezone); return `${parts.date}T${parts.time}` }
  return occurrence.logicalDate && occurrence.timeIntent?.startLocalTime && occurrence.timeIntent.timezone === timezone ? `${occurrence.logicalDate}T${occurrence.timeIntent.startLocalTime}` : ''
}

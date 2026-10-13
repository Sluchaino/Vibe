import type { TaskOccurrence } from '../api/types.ts'

export interface Command { method: 'POST' | 'PUT'; path: string; body: Record<string, unknown>; version?: string }
export interface PendingCommand extends Command { userId: string; opId: string }
export function captureCommand(userId: string, command: Command, opId = crypto.randomUUID()): PendingCommand {
  return { ...command, body: structuredClone({ ...command.body, opId }), userId, opId }
}
export function assertCommandIdentity(command: PendingCommand, userId: string | null) {
  if (command.userId !== userId) throw new Error('Операция принадлежит другому аккаунту. Войдите в исходный аккаунт.')
}
export type PlacementAction = 'place' | 'move' | 'unplace' | 'setFixed'
export const placementActionLabels: Record<PlacementAction, string> = {
  place: 'Разместить выполнение', move: 'Перенести весь блок', unplace: 'Снять с календаря', setFixed: 'Изменить фиксацию блока',
}
export function placementActions(occurrence: Pick<TaskOccurrence, 'calendarBlock'>): readonly PlacementAction[] {
  return occurrence.calendarBlock ? ['move', 'unplace', 'setFixed'] : ['place']
}
export function placementActionProblem(occurrence: Pick<TaskOccurrence, 'calendarBlock'>, action: PlacementAction) {
  if (placementActions(occurrence).includes(action)) return null
  return occurrence.calendarBlock
    ? 'У выполнения теперь есть блок. Исходное действие «Разместить выполнение» сохранено, но недоступно. Выберите нужное действие для существующего блока явно. Введённые время, зона, offset и флаг фиксации сохранены.'
    : `У выполнения больше нет блока. Исходное действие «${placementActionLabels[action]}» сохранено, но недоступно. Чтобы разместить выполнение заново, явно выберите «Разместить выполнение». Введённые время, зона, offset и флаг фиксации сохранены.`
}
export function assertPlacementAction(occurrence: Pick<TaskOccurrence, 'calendarBlock'>, action: PlacementAction) {
  const problem = placementActionProblem(occurrence, action)
  if (problem) throw new Error(problem)
}
export function effectiveFixed(occurrence: TaskOccurrence) { return !!occurrence.calendarBlock && (occurrence.calendarBlock.fixed || occurrence.constraintsSnapshot.mobilityPolicy === 'fixedAfterPlacement') }
export function fixedConfirmation(occurrence: TaskOccurrence, action: 'place' | 'move' | 'unplace' | 'setFixed' | 'snapshot', fixed?: boolean, mobility?: string) {
  if (!occurrence.calendarBlock) return false
  if (action === 'move' || action === 'unplace') return effectiveFixed(occurrence)
  if (action === 'setFixed') return occurrence.calendarBlock.fixed && fixed === false
  return action === 'snapshot' && occurrence.constraintsSnapshot.mobilityPolicy === 'fixedAfterPlacement' && mobility === 'movable'
}
// Every accepted/replayed mutation is followed by a fresh read. Opaque server
// versions cannot establish ordering, so mutation payloads never merge into cache.
export function mayUseResponse(startEpoch: number, currentEpoch: number, owner: string, currentUserId: string | null) { return startEpoch === currentEpoch && owner === currentUserId }
export function codePointLength(value: string) { return Array.from(value).length }

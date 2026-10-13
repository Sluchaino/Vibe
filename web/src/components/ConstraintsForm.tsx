import type { AvailabilityRules, ConstraintsSnapshot, MobilityPolicy } from '../api/types'
import { isTimezone } from '../lib/time'
import { AvailabilityForm } from './AvailabilityForm'
import { Field } from './shared'

export interface ConstraintsDraft { minutes: string; mobilityPolicy: MobilityPolicy; availabilityRules: AvailabilityRules; placeId: string }
export function constraintDraft(value: ConstraintsSnapshot): ConstraintsDraft { return { minutes: String(value.durationPolicy.requiredWorkMinutes), mobilityPolicy: value.mobilityPolicy, availabilityRules: structuredClone(value.availabilityRules), placeId: value.placeId } }
export function defaultConstraints(timezone: string, placeId: string): ConstraintsDraft { return { minutes: '60', mobilityPolicy: 'movable', availabilityRules: { timezone, windows: [], dateExceptions: [] }, placeId } }
export function constraints(value: ConstraintsDraft): ConstraintsSnapshot {
  const requiredWorkMinutes = Number(value.minutes)
  if (!/^\d+$/.test(value.minutes) || !Number.isInteger(requiredWorkMinutes) || requiredWorkMinutes < 1 || requiredWorkMinutes > 2_147_483_647) throw new Error('Длительность должна быть целым числом минут от 1 до 2147483647.')
  if (!value.placeId) throw new Error('Сначала задайте своё место в настройках.')
  if (!isTimezone(value.availabilityRules.timezone)) throw new Error('Укажите действительную IANA-зону разрешённых окон.')
  for (const window of value.availabilityRules.windows) {
    if (!window.daysOfWeek.length) throw new Error('Выберите хотя бы один день для каждого окна.')
    if (window.endDayOffset === 0 ? window.startLocalTime >= window.endLocalTime : window.endLocalTime > window.startLocalTime) throw new Error('Проверьте начало, конец и день окончания разрешённого окна.')
  }
  const dates = value.availabilityRules.dateExceptions.map(exception => exception.localDate)
  if (new Set(dates).size !== dates.length) throw new Error('Для одной даты можно задать только одно исключение.')
  return { durationPolicy: { mode: 'fixedWork', requiredWorkMinutes }, splitAllowed: false, mobilityPolicy: value.mobilityPolicy, availabilityRules: structuredClone(value.availabilityRules), placeId: value.placeId, requiredRestMinutes: 0 }
}
export function supportedConstraints(value: ConstraintsSnapshot) {
  const known = ['durationPolicy', 'splitAllowed', 'mobilityPolicy', 'availabilityRules', 'placeId', 'requiredRestMinutes']
  const rules = value.availabilityRules
  const windowsSupported = Array.isArray(rules?.windows) && rules.windows.every(window => Object.keys(window).every(key => ['daysOfWeek', 'startLocalTime', 'endLocalTime', 'endDayOffset'].includes(key)))
  const exceptionsSupported = Array.isArray(rules?.dateExceptions) && rules.dateExceptions.every(exception => Object.keys(exception).every(key => ['localDate', 'windows'].includes(key)) && Array.isArray(exception.windows) && exception.windows.every(window => Object.keys(window).every(key => ['startLocalTime', 'endLocalTime', 'endDayOffset', 'startUtcOffset', 'endUtcOffset'].includes(key))))
  return known.every(key => key in value) && Object.keys(value).every(key => known.includes(key)) && value.durationPolicy?.mode === 'fixedWork' && Object.keys(value.durationPolicy).every(key => ['mode', 'requiredWorkMinutes'].includes(key)) && value.splitAllowed === false && value.requiredRestMinutes === 0 && ['movable', 'fixedAfterPlacement'].includes(value.mobilityPolicy) && !!rules && Object.keys(rules).every(key => ['timezone', 'windows', 'dateExceptions'].includes(key)) && windowsSupported && exceptionsSupported
}
export function ConstraintsForm({ value, onChange, placeName }: { value: ConstraintsDraft; onChange: (value: ConstraintsDraft) => void; placeName: string }) {
  return <><div className="form-grid"><Field label="Полный объём, минуты" hint="Выполнение размещается одним блоком. Объём не сокращается, чтобы поместиться в календарь."><input type="number" required min="1" max="2147483647" step="1" inputMode="numeric" value={value.minutes} onChange={event => onChange({ ...value, minutes: event.target.value })} /></Field><Field label="Фиксация после размещения"><select value={value.mobilityPolicy} onChange={event => onChange({ ...value, mobilityPolicy: event.target.value as MobilityPolicy })}><option value="movable">Можно переносить вручную</option><option value="fixedAfterPlacement">Закрепить выбранное время</option></select></Field></div><p className="muted">Место: <strong>{placeName}</strong>. Работа без дробления и обязательного отдыха на этом этапе.</p><AvailabilityForm value={value.availabilityRules} onChange={availabilityRules => onChange({ ...value, availabilityRules })} /></>
}

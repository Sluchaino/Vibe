import type { AvailabilityRules } from '../api/types.ts'
import { addDays, resolveLocalTime } from './time.ts'
import { validDate } from './task-timing.ts'

export function hasTimeLimits(rules: AvailabilityRules) { return rules.windows.length > 0 || rules.dateExceptions.length > 0 }
// Resolve only the request copy. Folding the editor never modifies the rules;
// a repeated hour still requires the original explicit choice.
export function resolvedAvailability(rules: AvailabilityRules): AvailabilityRules {
  const localTime = /^([01]\d|2[0-3]):[0-5]\d$/
  for (const window of [...rules.windows, ...rules.dateExceptions.flatMap(exception => exception.windows)]) {
    if (!localTime.test(window.startLocalTime) || !localTime.test(window.endLocalTime) || ![0, 1].includes(window.endDayOffset)) throw new Error('Проверьте начало, конец и день окончания каждого разрешённого окна.')
  }
  for (const exception of rules.dateExceptions) {
    try { validDate(exception.localDate) } catch { throw new Error('Укажите действительную дату каждого исключения в разрешённых окнах.') }
  }
  return { ...structuredClone(rules), dateExceptions: rules.dateExceptions.map(exception => ({
    ...exception,
    windows: exception.windows.map(window => ({
      ...window,
      startUtcOffset: resolveLocalTime(`${exception.localDate}T${window.startLocalTime}:00`, rules.timezone, window.startUtcOffset).utcOffset,
      endUtcOffset: resolveLocalTime(`${addDays(exception.localDate, window.endDayOffset)}T${window.endLocalTime}:00`, rules.timezone, window.endUtcOffset).utcOffset,
    })),
  })) }
}

const MINUTE = 60_000
const DAY = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string) {
  let value = formatters.get(timezone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    formatters.set(timezone, value)
  }
  return value
}
export function isTimezone(value: string) {
  // Intl also accepts offset identifiers in newer engines; wire requires an IANA name.
  if (!value || /^[+-]/.test(value)) return false
  try { formatter(value).format(0); return true } catch { return false }
}
export function localParts(instant: string | number, timezone: string) {
  const parts = formatter(timezone).formatToParts(typeof instant === 'string' ? new Date(instant) : instant)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return { date: `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}`, second: get('second') }
}
function wallTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(value)) throw new Error('Укажите действительные дату и время с точностью до минуты.')
  const stamp = Date.parse(`${value}Z`)
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 19) !== value) throw new Error('Укажите действительные дату и время.')
  return stamp
}
export function addDays(date: string, count: number) {
  const stamp = wallTimestamp(`${date}T00:00:00`)
  const result = new Date(stamp + count * DAY).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('Дата выходит за поддерживаемые границы.')
  return result
}
export function monday(date: string) {
  const day = new Date(wallTimestamp(`${date}T00:00:00`)).getUTCDay()
  return addDays(date, -((day + 6) % 7))
}
export function toUtc(stamp: number) {
  const result = new Date(stamp).toISOString().replace('.000Z', 'Z')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(result)) throw new Error('Это время нельзя представить с точностью до минуты.')
  return result
}
function offsetLabel(minutes: number) {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
export interface LocalCandidate { utcOffset: string; instant: string }
export function localCandidates(localStart: string, timezone: string): LocalCandidate[] {
  const wall = wallTimestamp(localStart)
  if (!isTimezone(timezone)) throw new Error('Укажите действительную IANA-зону, например Europe/Moscow.')
  const date = localStart.slice(0, 10)
  const time = localStart.slice(11, 16)
  const result: LocalCandidate[] = []
  // Enumerate every representable wire offset, then verify against IANA. This also
  // handles non-hour transitions; no machine timezone or guessed DST offset.
  for (let offset = -14 * 60; offset <= 14 * 60; offset++) {
    const stamp = wall - offset * MINUTE
    const parts = localParts(stamp, timezone)
    if (parts.date === date && parts.time === time && parts.second === '00') result.push({ utcOffset: offsetLabel(offset), instant: toUtc(stamp) })
  }
  return result.sort((a, b) => a.instant.localeCompare(b.instant))
}
export function selectedInstant(localStart: string, timezone: string, utcOffset: string) {
  const candidate = localCandidates(localStart, timezone).find(item => item.utcOffset === utcOffset)
  if (!candidate) throw new Error('Выберите действительный UTC offset для этого времени.')
  return candidate.instant
}
export function startOfLocalDate(date: string, timezone: string) {
  const candidates = localCandidates(`${date}T00:00:00`, timezone)
  if (candidates[0]) return candidates[0].instant
  // Some zones skip midnight. The calendar starts at the first existing minute
  // of that date, without changing any manually entered placement.
  const wall = wallTimestamp(`${date}T00:00:00`)
  for (let stamp = wall - 14 * 60 * MINUTE; stamp <= wall + 38 * 60 * MINUTE; stamp += MINUTE) {
    const parts = localParts(stamp, timezone)
    if (parts.date === date && parts.second === '00') return toUtc(stamp)
  }
  throw new Error(`Дата ${date} отсутствует в зоне ${timezone}. Выберите другую дату.`)
}
export function calendarRange(date: string, view: 'day' | 'week', timezone: string) {
  const startDate = view === 'week' ? monday(date) : date
  const count = view === 'week' ? 7 : 1
  return { from: startOfLocalDate(startDate, timezone), to: startOfLocalDate(addDays(startDate, count), timezone), dates: Array.from({ length: count }, (_, index) => addDays(startDate, index)) }
}
export function elapsedEnd(start: string, minutes: number) { return toUtc(Date.parse(start) + minutes * MINUTE) }
export function intersects(start: string, end: string, from: string, to: string) { return start < to && end > from }
export function today(timezone: string) { return localParts(Date.now(), timezone).date }
export function dateLabel(date: string, short = false) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: short ? 'short' : 'long', day: 'numeric', month: short ? 'short' : 'long' }).format(new Date(`${date}T12:00:00Z`))
}
export function instantLabel(instant: string, timezone: string) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(new Date(instant))
}

// Time zones and formatting. Pure functions: nothing here touches `$`.

export const SEC = 1000
export const MIN = 60 * SEC
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A named zone follows its daylight-saving rules; a fixed offset never moves. */
export type Zone = { kind: 'iana'; name: string } | { kind: 'offset'; minutes: number }

export type DateFormat = 'weekday' | 'iso' | 'us' | 'eu'

export type Clock = { is12h: boolean; hasSeconds: boolean; dateFormat: DateFormat }

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; offset: number }

const pad = (n: number) => String(n).padStart(2, '0')

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(name: string) {
  let formatter = formatters.get(name)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    })
    formatters.set(name, formatter)
  }
  return formatter
}

export function isZoneName(name: string) {
  try {
    formatterFor(name)
    return true
  } catch {
    return false
  }
}

export function partsOf(ms: number, zone: Zone): Parts {
  if (zone.kind === 'offset') {
    const d = new Date(ms + zone.minutes * MIN)
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      weekday: d.getUTCDay(),
      offset: zone.minutes,
    }
  }
  const p: Record<string, string> = {}
  for (const { type, value } of formatterFor(zone.name).formatToParts(ms)) p[type] = value
  const year = Number(p.year)
  const month = Number(p.month)
  const day = Number(p.day)
  const hour = Number(p.hour) % 24
  const minute = Number(p.minute)
  const second = Number(p.second)
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  return { year, month, day, hour, minute, second, weekday: WEEKDAYS.indexOf(p.weekday ?? ''), offset: Math.round((wall - Math.floor(ms / SEC) * SEC) / MIN) }
}

/**
 * A zone from what a person typed: `Europe/Berlin`, `UTC`, `+02:00`,
 * `UTC+2`, `GMT-05:30`. `auto`, empty or unreadable text answers undefined.
 */
export function parseZone(text: string | undefined): Zone | undefined {
  const t = (text ?? '').trim()
  if (t === '' || t.toLowerCase() === 'auto') return undefined
  if (/^(utc|gmt|z|etc\/utc)$/i.test(t)) return { kind: 'offset', minutes: 0 }
  const m = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(t)
  if (m) {
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0)
    if (minutes <= 14 * 60) return { kind: 'offset', minutes: m[1] === '-' ? -minutes : minutes }
    return undefined
  }
  return isZoneName(t) ? { kind: 'iana', name: t } : undefined
}

/** The zone the host's JavaScript runtime reports, unless it is plain UTC. */
export function systemZone(): Zone | undefined {
  try {
    const name = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (name && !/^(etc\/)?(utc|gmt|uct|zulu|universal)$/i.test(name) && isZoneName(name)) return { kind: 'iana', name }
  } catch {}
  const offset = -new Date().getTimezoneOffset()
  return offset !== 0 ? { kind: 'offset', minutes: offset } : undefined
}

export function fmtOffset(minutes: number) {
  const abs = Math.abs(minutes)
  return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function zoneLabel(zone: Zone, at: number) {
  const offset = fmtOffset(partsOf(at, zone).offset)
  return zone.kind === 'iana' ? `${zone.name} (${offset})` : offset
}

export function dayKey(ms: number, zone: Zone) {
  const p = partsOf(ms, zone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function fmtTime(ms: number, zone: Zone, clock: Clock, hasSeconds = clock.hasSeconds) {
  const p = partsOf(ms, zone)
  const s = hasSeconds ? `:${pad(p.second)}` : ''
  if (!clock.is12h) return `${pad(p.hour)}:${pad(p.minute)}${s}`
  return `${p.hour % 12 || 12}:${pad(p.minute)}${s} ${p.hour < 12 ? 'AM' : 'PM'}`
}

export function fmtDate(ms: number, zone: Zone, clock: Clock) {
  const p = partsOf(ms, zone)
  const wd = WEEKDAYS[p.weekday] ?? ''
  const mon = MONTHS[p.month - 1] ?? ''
  switch (clock.dateFormat) {
    case 'iso':
      return `${p.year}-${pad(p.month)}-${pad(p.day)}`
    case 'us':
      return `${wd}, ${mon} ${p.day}, ${p.year}`
    case 'eu':
      return `${wd} ${pad(p.day)}.${pad(p.month)}.${p.year}`
    default:
      return `${wd} ${p.day} ${mon} ${p.year}`
  }
}

/** A short day label for tables: `Mon 12 Oct`, `Mon 10-12`, `Mon Oct 12`, `Mon 12.10`. */
export function fmtDay(ms: number, zone: Zone, clock: Clock) {
  const p = partsOf(ms, zone)
  const wd = WEEKDAYS[p.weekday] ?? ''
  const mon = MONTHS[p.month - 1] ?? ''
  switch (clock.dateFormat) {
    case 'iso':
      return `${wd} ${pad(p.month)}-${pad(p.day)}`
    case 'us':
      return `${wd} ${mon} ${p.day}`
    case 'eu':
      return `${wd} ${pad(p.day)}.${pad(p.month)}`
    default:
      return `${wd} ${p.day} ${mon}`
  }
}

/** Days between two local dates, by their day keys. */
export function daysBetween(fromMs: number, toMs: number, zone: Zone) {
  return Math.round((Date.parse(dayKey(toMs, zone)) - Date.parse(dayKey(fromMs, zone))) / DAY)
}

/** The time alone today, "Yesterday 14:05", the weekday within a week, else the date. */
export function fmtWhen(ms: number, now: number, zone: Zone, clock: Clock, hasSeconds = false) {
  const time = fmtTime(ms, zone, clock, hasSeconds)
  const days = daysBetween(ms, now, zone)
  if (days === 0) return time
  if (days === 1) return `Yesterday ${time}`
  if (days === -1) return `Tomorrow ${time}`
  if (days > 1 && days < 7) return `${WEEKDAYS[partsOf(ms, zone).weekday]} ${time}`
  return `${fmtDate(ms, zone, clock)} ${time}`
}

export function fmtDur(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '–'
  if (ms < SEC) return `${Math.round(ms)}ms`
  if (ms < MIN) return `${(ms / SEC).toFixed(ms < 10 * SEC ? 1 : 0)}s`
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ${pad(Math.floor((ms % MIN) / SEC))}s`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${pad(Math.floor((ms % HOUR) / MIN))}m`
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`
}

export function fmtTok(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtUsd(n: number) {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${n.toFixed(0)}`
}

export const pct = (n: number) => `${Math.round(n)}%`
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

const SPARKS = '▁▂▃▄▅▆▇█'

export function bar(percent: number, width: number) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function spark(values: number[]) {
  const max = Math.max(...values, 0)
  if (max <= 0) return values.map(() => SPARKS[0]).join('')
  return values.map(v => SPARKS[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}

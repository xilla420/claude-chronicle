import { expect, test } from 'claude-code/testing'

import { dayKey, fmtDate, fmtTime, fmtWhen, parseZone, zoneLabel } from '../hooks/time'
import type { Clock } from '../hooks/time'

const clock: Clock = { is12h: false, hasSeconds: true, dateFormat: 'weekday' }
const berlin = parseZone('Europe/Berlin')!

test('a named zone follows daylight saving across the October change', () => {
  expect(fmtTime(Date.parse('2026-10-24T12:00:00Z'), berlin, clock)).toBe('14:00:00')
  expect(fmtTime(Date.parse('2026-10-26T12:00:00Z'), berlin, clock)).toBe('13:00:00')
  expect(zoneLabel(berlin, Date.parse('2026-10-24T12:00:00Z'))).toBe('Europe/Berlin (UTC+02:00)')
  expect(zoneLabel(berlin, Date.parse('2026-10-26T12:00:00Z'))).toBe('Europe/Berlin (UTC+01:00)')
})

test('the local day turns at local midnight, not UTC midnight', () => {
  expect(dayKey(Date.parse('2026-10-12T22:30:00Z'), berlin)).toBe('2026-10-13')
  expect(dayKey(Date.parse('2026-10-12T22:30:00Z'), parseZone('UTC')!)).toBe('2026-10-12')
})

test('offsets, UTC, auto and nonsense parse as they should', () => {
  expect(parseZone('+02:00')).toEqual({ kind: 'offset', minutes: 120 })
  expect(parseZone('UTC-5')).toEqual({ kind: 'offset', minutes: -300 })
  expect(parseZone('gmt+05:30')).toEqual({ kind: 'offset', minutes: 330 })
  expect(parseZone('UTC')).toEqual({ kind: 'offset', minutes: 0 })
  expect(parseZone('auto')).toBeUndefined()
  expect(parseZone('')).toBeUndefined()
  expect(parseZone('Mars/Olympus')).toBeUndefined()
  expect(parseZone('+99:00')).toBeUndefined()
})

test('date formats, the 12-hour clock and relative days', () => {
  const at = Date.parse('2026-10-12T10:05:07Z')
  const utc = parseZone('UTC')!
  expect(fmtDate(at, utc, clock)).toBe('Mon 12 Oct 2026')
  expect(fmtDate(at, utc, { ...clock, dateFormat: 'iso' })).toBe('2026-10-12')
  expect(fmtDate(at, utc, { ...clock, dateFormat: 'us' })).toBe('Mon, Oct 12, 2026')
  expect(fmtDate(at, utc, { ...clock, dateFormat: 'eu' })).toBe('Mon 12.10.2026')
  expect(fmtTime(Date.parse('2026-10-12T15:04:00Z'), utc, { ...clock, is12h: true, hasSeconds: false })).toBe('3:04 PM')
  expect(fmtTime(Date.parse('2026-10-12T00:04:00Z'), utc, { ...clock, is12h: true, hasSeconds: false })).toBe('12:04 AM')
  expect(fmtWhen(at, at + 86_400_000, utc, clock)).toBe('Yesterday 10:05')
  expect(fmtWhen(at, at + 3 * 86_400_000, utc, clock)).toBe('Mon 10:05')
})

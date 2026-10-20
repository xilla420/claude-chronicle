import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Breakdown, DayTotal, Marks, Meter, Stamp, TurnRecord, View, ZoneSetting } from '../types'
import {
  DAY,
  HOUR,
  MIN,
  bar,
  dayKey,
  fmtDate,
  fmtDay,
  fmtDur,
  fmtTime,
  fmtTok,
  fmtUsd,
  fmtWhen,
  parseZone,
  pct,
  spark,
  sum,
  systemZone,
  zoneLabel,
} from './time'
import type { Clock, DateFormat, Zone } from './time'

type $ = EngineInterface

const PANE = 'chronicle'
const STAMP = { plugin: 'chronicle', key: 'stamp' } as const

const turnsAtom = atom({ plugin: 'chronicle', key: 'turns' } as const, [])
const toolsAtom = atom({ plugin: 'chronicle', key: 'tools' } as const, {})
const meterAtom = atom({ plugin: 'chronicle', key: 'meter' } as const, null)
const breakdownAtom = atom({ plugin: 'chronicle', key: 'breakdown' } as const, null)
const marksAtom = atom({ plugin: 'chronicle', key: 'marks' } as const, { turnTools: 0 })
const zoneAtom = atom({ plugin: 'chronicle', key: 'zone' } as const, { zone: { kind: 'offset', minutes: 0 }, source: 'utc' })
const viewAtom = atom({ plugin: 'chronicle', key: 'view' } as const, 'overview')
const tickAtom = atom({ plugin: 'chronicle', key: 'tick' } as const, 0)
const alertedAtom = atom({ plugin: 'chronicle', key: 'alerted' } as const, [])
const daysAtom = atom({ plugin: 'chronicle', key: 'days' } as const, {})

const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const IDLE_NOTE_MS = 15 * MIN

// ─── settings ────────────────────────────────────────────────────────────────

type Settings = {
  clock: Clock
  timezone: string
  stamps: 'both' | 'prompts' | 'replies' | 'off'
  showElapsed: boolean
  footer: 'full' | 'compact' | 'off'
  status: 'full' | 'compact' | 'off'
  alerts: boolean
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function readSettings(options: PluginOptions): Settings {
  const footerStyle = pick(options.footerStyle, ['full', 'compact'] as const, 'full')
  const statusStyle = pick(options.statusStyle, ['full', 'compact'] as const, 'full')
  return {
    clock: {
      is12h: options.clock === '12h',
      hasSeconds: options.seconds !== false,
      dateFormat: pick<DateFormat>(options.dateFormat, ['weekday', 'iso', 'us', 'eu'], 'weekday'),
    },
    timezone: typeof options.timezone === 'string' ? options.timezone : 'auto',
    stamps: pick(options.stamps, ['both', 'prompts', 'replies', 'off'] as const, 'both'),
    showElapsed: options.showElapsed !== false,
    footer: options.turnFooter === false ? 'off' : footerStyle,
    status: options.statusLine === false ? 'off' : statusStyle,
    alerts: options.alerts !== false,
  }
}

// ─── pure helpers ────────────────────────────────────────────────────────────

const level = (percent: number) => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')

const limitName = (kind: string) =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind === 'spend_limit' ? 'Spend' : kind
const limitShort = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? '$' : kind

/** What a rate-limit window will read at its reset if the pace so far holds. */
function pace(limit: Meter['rateLimits'][number], now: number) {
  const span = WINDOW_MS[limit.kind]
  if (!span || !limit.resetsAt) return undefined
  const left = Date.parse(limit.resetsAt) - now
  const elapsed = (span - left) / span
  if (!(elapsed > 0.05) || left <= 0) return undefined
  return limit.percentUsed / elapsed
}

/** How many more turns of the recent context growth fit before compaction. */
function turnsLeft(turns: TurnRecord[], meter: Meter | null, breakdown: Breakdown | null) {
  const recent = turns.filter(t => t.contextTokens !== undefined).slice(-6)
  if (recent.length < 2 || meter?.contextTokens === undefined) return undefined
  const growth: number[] = []
  for (let i = 1; i < recent.length; i++) {
    const d = (recent[i]?.contextTokens ?? 0) - (recent[i - 1]?.contextTokens ?? 0)
    if (d > 0) growth.push(d)
  }
  if (growth.length === 0) return undefined
  const ceiling = breakdown?.autoCompactAt ?? meter.contextWindow
  return Math.max(0, Math.floor((ceiling - meter.contextTokens) / (sum(growth) / growth.length)))
}

function tokenTotals(turns: TurnRecord[]) {
  const input = sum(turns.map(t => t.input))
  const cacheRead = sum(turns.map(t => t.cacheRead))
  const cacheWrite = sum(turns.map(t => t.cacheWrite))
  const output = sum(turns.map(t => t.output))
  const allIn = input + cacheRead + cacheWrite
  return { input, cacheRead, cacheWrite, output, allIn, hit: allIn > 0 ? (cacheRead / allIn) * 100 : 0 }
}

function buildStamp(role: Stamp['role'], at: number, marks: Marks, zone: Zone): Stamp {
  const stamp: Stamp = { at, role }
  const since = role === 'user' ? marks.lastReplyAt : marks.lastPromptAt
  if (since !== undefined) stamp.gapMs = Math.max(0, at - since)
  if (marks.lastDay !== dayKey(at, zone)) stamp.isNewDay = true
  return stamp
}

function advance(marks: Marks, role: Stamp['role'], at: number, zone: Zone): Marks {
  return { ...marks, lastDay: dayKey(at, zone), ...(role === 'user' ? { lastPromptAt: at } : { lastReplyAt: at }) }
}

function toMeter(at: number, usage: { context: any; rateLimits: any[]; cost?: { usd: number } }): Meter {
  const meter: Meter = {
    at,
    contextWindow: usage.context.window,
    rateLimits: usage.rateLimits.map(r => (r.resetsAt ? { kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt } : { kind: r.kind, percentUsed: r.percentUsed })),
  }
  if (usage.context.tokens !== undefined) meter.contextTokens = usage.context.tokens
  if (usage.context.percent !== undefined) meter.contextPercent = usage.context.percent
  if (usage.cost) meter.usd = usage.cost.usd
  return meter
}

function summaryLine(turn: TurnRecord, now: number, zone: Zone, settings: Settings) {
  const allIn = turn.input + turn.cacheRead + turn.cacheWrite
  const clock = settings.clock
  const parts =
    settings.footer === 'compact'
      ? [
          `⏱ ${fmtTime(now, zone, clock, false)}`,
          fmtDur(turn.durationMs),
          turn.usd > 0 ? fmtUsd(turn.usd) : undefined,
          turn.contextPercent !== undefined ? `ctx ${pct(turn.contextPercent)}` : undefined,
        ]
      : [
          `⏱ done ${fmtTime(now, zone, clock)}`,
          `took ${fmtDur(turn.durationMs)}`,
          turn.usd > 0 ? fmtUsd(turn.usd) : undefined,
          allIn + turn.output > 0 ? `↑${fmtTok(allIn)} ↓${fmtTok(turn.output)} tok` : undefined,
          allIn > 0 ? `cache ${pct((turn.cacheRead / allIn) * 100)}` : undefined,
          turn.contextPercent !== undefined ? `ctx ${pct(turn.contextPercent)}` : undefined,
          turn.tools > 0 ? `${turn.tools} tool${turn.tools === 1 ? '' : 's'}` : undefined,
        ]
  if (turn.reason !== 'answer') parts.push(turn.reason === 'aborted' ? 'interrupted' : turn.reason)
  return parts.filter(Boolean).join(' · ')
}

// ─── the zone ────────────────────────────────────────────────────────────────

/**
 * Where times are shown: the `timezone` setting, else `CHRONICLE_TZ`, else
 * the runtime's zone, else the host's offset (a probe), else UTC. A cloud VM
 * runs on UTC, so a setting or `CHRONICLE_TZ` is how it learns the person's.
 */
async function resolveZone($: $, setting: string): Promise<ZoneSetting> {
  const fromSetting = parseZone(setting)
  if (fromSetting) return { zone: fromSetting, source: 'setting' }
  const fromEnv = parseZone(await $.env.get('CHRONICLE_TZ'))
  if (fromEnv) return { zone: fromEnv, source: 'env' }
  const system = systemZone()
  if (system) return { zone: system, source: 'system' }
  const probed = await probeOffset($)
  if (probed !== undefined) return { zone: { kind: 'offset', minutes: probed }, source: 'probe' }
  return { zone: { kind: 'offset', minutes: 0 }, source: 'utc' }
}

async function probeOffset($: $) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const powershell = ['powershell', '-NoProfile', '-NonInteractive', '-Command', '[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalMinutes']
  const posix = ['date', '+%z']
  for (const argv of isWindows ? [powershell, posix] : [posix]) {
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 10_000 })
      const text = stdout.trim()
      if (exitCode !== 0) continue
      const hhmm = /^([+-])(\d\d)(\d\d)$/.exec(text)
      const minutes = hhmm ? (hhmm[1] === '-' ? -1 : 1) * (Number(hhmm[2]) * 60 + Number(hhmm[3])) : /^-?\d+$/.test(text) ? Number(text) : undefined
      if (minutes !== undefined && minutes !== 0) return minutes
    } catch {}
  }
  return undefined
}

/** Until session.start has settled the zone, the setting or the runtime's zone stands in. */
let fallbackZone: ZoneSetting = { zone: { kind: 'offset', minutes: 0 }, source: 'utc' }

function quickZone(setting: string): ZoneSetting {
  const fromSetting = parseZone(setting)
  if (fromSetting) return { zone: fromSetting, source: 'setting' }
  const system = systemZone()
  return system ? { zone: system, source: 'system' } : { zone: { kind: 'offset', minutes: 0 }, source: 'utc' }
}

async function zoneSetting($: $): Promise<ZoneSetting> {
  const held = await $.state.get({ plugin: 'chronicle', key: 'zone' } as const)
  return held.version === 0 || held.value === undefined ? fallbackZone : held.value
}

async function zoneOf($: $) {
  return (await zoneSetting($)).zone
}

// ─── recording ───────────────────────────────────────────────────────────────

async function stampRow($: $, uuid: string, role: Stamp['role'], at: number) {
  const zone = await zoneOf($)
  const marks = await read($, marksAtom)
  await setIfMissing($, uuid, buildStamp(role, at, marks, zone))
  await update($, marksAtom, m => advance(m, role, at, zone))
}

async function setIfMissing($: $, key: string, stamp: Stamp) {
  const existing = await $.state.get({ ...STAMP, id: key })
  if (existing.value === undefined) await $.state.set({ ...STAMP, id: key }, stamp)
}

/**
 * The session's transcript file: the ground truth for when every row was
 * stored. Read incrementally; a reply row is keyed both by its uuid (what the
 * terminal draws it under) and by `<API message id>-t<text block index>`
 * (what the desktop draws it under).
 */
type TextRow = { keys: string[]; at: number }
const sync = {
  path: undefined as string | undefined,
  lines: 0,
  textIndex: new Map<string, number>(),
  marks: { turnTools: 0 } as Marks,
  rows: [] as TextRow[],
  isBusy: false,
}

async function findTranscript($: $) {
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`).replace(/\\/g, '/')
  const projects = `${config}/projects`
  const direct = `${projects}/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(direct)) return direct
  if (!(await $.fs.exists(projects))) return undefined
  for (const dir of await $.fs.list(projects)) {
    const candidate = `${projects}/${dir.name}/${id}.jsonl`
    if (await $.fs.exists(candidate)) return candidate
  }
  return undefined
}

async function syncTranscript($: $) {
  if (sync.isBusy) return
  sync.isBusy = true
  try {
    sync.path ??= await findTranscript($)
    if (!sync.path) return
    const lines = (await $.fs.read(sync.path)).split('\n')
    // the last element is '' after a final newline, or a line still being written
    const fresh = lines.slice(sync.lines, lines.length - 1)
    sync.lines += fresh.length
    const zone = await zoneOf($)
    for (const line of fresh) {
      if (!line.includes('"uuid"')) continue
      let row: any
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row.isSidechain || row.isMeta || (row.type !== 'user' && row.type !== 'assistant')) continue
      const at = Date.parse(row.timestamp)
      if (!row.uuid || !Number.isFinite(at)) continue
      const content = row.message?.content
      const blocks: any[] = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
      if (row.type === 'user') {
        if (blocks.some(b => b?.type === 'tool_result')) continue
        await setIfMissing($, row.uuid, buildStamp('user', at, sync.marks, zone))
        sync.marks = advance(sync.marks, 'user', at, zone)
        continue
      }
      if (!blocks.some(b => b?.type === 'text')) continue
      const keys = [row.uuid]
      const messageId = row.message?.id
      if (typeof messageId === 'string') {
        const index = sync.textIndex.get(messageId) ?? 0
        sync.textIndex.set(messageId, index + 1)
        keys.push(`${messageId}-t${index}`)
      }
      const stamp = buildStamp('assistant', at, sync.marks, zone)
      for (const key of keys) await setIfMissing($, key, stamp)
      sync.marks = advance(sync.marks, 'assistant', at, zone)
      sync.rows.push({ keys, at })
      if (sync.rows.length > 3000) sync.rows.shift()
    }
  } finally {
    sync.isBusy = false
  }
}

/** Reply blocks drawn before the transcript had them: sync soon, then fall back to when they were first drawn. */
const firstSeen = new Map<string, number>()
let isSyncQueued = false

function queueSync($: $) {
  if (isSyncQueued) return
  isSyncQueued = true
  $.clock.after(400, () => {
    isSyncQueued = false
    void settleUnseen($).catch(() => {})
  })
}

async function settleUnseen($: $) {
  await syncTranscript($).catch(() => {})
  const marks = await read($, marksAtom)
  const zone = await zoneOf($)
  for (const [key, at] of firstSeen) {
    const { value } = await $.state.get({ ...STAMP, id: key })
    if (value !== undefined) {
      firstSeen.delete(key)
      continue
    }
    // give the transcript a few seconds to catch up before settling on first sight
    if ((await $.clock.now()) - at < 3000) {
      queueSync($)
      continue
    }
    firstSeen.delete(key)
    const stamp: Stamp = { at, role: 'assistant' }
    if (marks.lastPromptAt !== undefined && at >= marks.lastPromptAt) stamp.gapMs = at - marks.lastPromptAt
    if (marks.lastDay !== dayKey(at, zone)) stamp.isNewDay = true
    await setIfMissing($, key, stamp)
  }
}

/** The usage line rides on the turn's last reply block, where it is always visible. */
async function attachSummary($: $, since: number, summary: string) {
  await syncTranscript($).catch(() => {})
  const last = [...sync.rows].reverse().find(r => r.at >= since - 1000)
  if (!last) return false
  for (const key of last.keys) {
    const { value } = await $.state.get({ ...STAMP, id: key })
    if (value) await $.state.set({ ...STAMP, id: key }, { ...value, summary })
  }
  return true
}

async function refreshBreakdown($: $) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return
  const breakdown: Breakdown = {
    at: await $.clock.now(),
    categories: b.categories
      .filter(c => !c.isDeferred && c.kind !== 'free' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
      .sort((x, y) => y.tokens - x.tokens),
    total: b.totalTokens,
    max: b.rawMaxTokens,
  }
  if (b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined) breakdown.autoCompactAt = b.autoCompactThreshold
  await update($, breakdownAtom, () => breakdown)
}

type SessionDays = Record<string, Record<string, Omit<DayTotal, 'sessions'>>>

/** Across sessions: per session, per local day. Read fresh so sessions don't clobber. */
async function recordDay($: $, turn: TurnRecord) {
  const id = await $.session.id()
  const zone = await zoneOf($)
  const key = dayKey(turn.at, zone)
  const all = ((await $.store.get('sessions')) ?? {}) as SessionDays
  const mine = (all[id] ??= {})
  const day = (mine[key] ??= { usd: 0, turns: 0, output: 0 })
  day.usd += turn.usd
  day.turns += 1
  day.output += turn.output
  const oldest = dayKey(turn.at - 60 * DAY, zone)
  for (const [sid, days] of Object.entries(all)) {
    for (const k of Object.keys(days)) if (k < oldest) delete days[k]
    if (Object.keys(days).length === 0) delete all[sid]
  }
  await $.store.set('sessions', all)
  await loadDays($, all)
}

async function loadDays($: $, all?: SessionDays) {
  all ??= ((await $.store.get('sessions')) ?? {}) as SessionDays
  const days: Record<string, DayTotal> = {}
  for (const [sid, perDay] of Object.entries(all)) {
    for (const [k, d] of Object.entries(perDay)) {
      const into = (days[k] ??= { usd: 0, turns: 0, output: 0, sessions: [] })
      into.usd += d.usd
      into.turns += d.turns
      into.output += d.output
      into.sessions.push(sid)
    }
  }
  await update($, daysAtom, () => days)
}

/**
 * Once per install: fold in the spend history any earlier install of
 * Chronicle kept (another marketplace name, the dev copy), so a move or a
 * rename keeps the History tab. Days this install already has win.
 */
async function importHistory($: $) {
  if ((await $.store.get('imported')) === true) return
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`).replace(/\\/g, '/')
  const dir = `${config}/plugins/store`
  const merged = ((await $.store.get('sessions')) ?? {}) as SessionDays
  if (await $.fs.exists(dir)) {
    for (const entry of await $.fs.list(dir)) {
      if (!/^chronicle_.*\.json$/.test(entry.name)) continue
      try {
        const other = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))?.sessions as SessionDays | undefined
        for (const [sid, perDay] of Object.entries(other ?? {})) {
          const into = (merged[sid] ??= {})
          for (const [k, d] of Object.entries(perDay)) into[k] ??= d
        }
      } catch {}
    }
  }
  await $.store.set('sessions', merged)
  await $.store.set('imported', true)
}

async function alerts($: $, meter: Meter, now: number, settings: Settings) {
  if (!settings.alerts) return
  const zone = await zoneOf($)
  const alerted = await read($, alertedAtom)
  const fresh: string[] = []
  for (const limit of meter.rateLimits) {
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
    const resets = resetsAt !== undefined ? ` · resets ${fmtWhen(resetsAt, now, zone, settings.clock)} (in ${fmtDur(resetsAt - now)})` : ''
    const step = [95, 80, 50].find(t => limit.percentUsed >= t)
    if (step !== undefined) {
      const key = `${limit.kind}:${step}:${limit.resetsAt ?? ''}`
      if (!alerted.includes(key)) {
        fresh.push(key)
        $.ui.toast(`${limitName(limit.kind)} limit at ${pct(limit.percentUsed)}${resets}`, { timeoutMs: 8000 })
      }
    }
    // a heads-up once per window when the pace says it will run out before it resets
    const p = pace(limit, now)
    const paceKey = `pace:${limit.kind}:${limit.resetsAt ?? ''}`
    if (p !== undefined && p >= 100 && limit.percentUsed >= 25 && !alerted.includes(paceKey)) {
      fresh.push(paceKey)
      $.ui.toast(`On pace to use ~${pct(p)} of the ${limitName(limit.kind)} limit before it resets${resets}`, { timeoutMs: 10_000 })
    }
  }
  const ctx = meter.contextPercent ?? 0
  const kept = ctx < 50 ? alerted.filter(k => !k.startsWith('ctx:')) : alerted
  const ctxStep = [90, 75].find(t => ctx >= t)
  if (ctxStep !== undefined && !kept.includes(`ctx:${ctxStep}`)) {
    fresh.push(`ctx:${ctxStep}`)
    $.ui.toast(`Context ${pct(ctx)} full · ${fmtTok(meter.contextTokens ?? 0)} / ${fmtTok(meter.contextWindow)} tokens`, { timeoutMs: 8000 })
  }
  if (fresh.length > 0 || kept !== alerted) await update($, alertedAtom, () => [...kept, ...fresh].slice(-100))
}

async function statusLine($: $, settings: Settings) {
  if (settings.status === 'off') return
  const now = await $.clock.now()
  const zone = await zoneOf($)
  const usage = await $.session.usage()
  const isCompact = settings.status === 'compact'
  const parts = [fmtTime(now, zone, settings.clock, false)]
  if (usage.cost) {
    const hours = (now - usage.startedAt) / HOUR
    parts.push(!isCompact && hours > 0.1 ? `${fmtUsd(usage.cost.usd)} (${fmtUsd(usage.cost.usd / hours)}/h)` : fmtUsd(usage.cost.usd))
  }
  if (usage.context.percent !== undefined) parts.push(`ctx ${pct(usage.context.percent)}`)
  for (const limit of usage.rateLimits) {
    const resets = !isCompact && limit.resetsAt ? ` ↻${fmtWhen(Date.parse(limit.resetsAt), now, zone, settings.clock)}` : ''
    parts.push(`${limitShort(limit.kind)} ${pct(limit.percentUsed)}${resets}`)
  }
  $.ui.status(parts.join(' · '))
}

/** A row's stamp: the time, with the date on a new day or a day not today. */
async function label($: $, stamp: Stamp, clock: Clock) {
  const zone = await zoneOf($)
  const now = await $.clock.now()
  const time = fmtTime(stamp.at, zone, clock)
  const isOtherDay = dayKey(stamp.at, zone) !== dayKey(now, zone)
  return stamp.isNewDay || isOtherDay ? `${fmtDate(stamp.at, zone, clock)} · ${time}` : time
}

async function boot($: $, settings: Settings) {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  await update($, marksAtom, m => (m.lastUsd === undefined ? { ...m, lastUsd: usage.cost?.usd ?? 0 } : m))
  await update($, meterAtom, () => toMeter(now, usage))
  const zone = await resolveZone($, settings.timezone)
  await update($, zoneAtom, () => zone)
  await importHistory($).catch(() => {})
  await loadDays($)
  await syncTranscript($).catch(() => {})
  await statusLine($, settings)
}

// ─── text reports (/chronicle report, today, tz) ─────────────────────────────

async function report($: $, settings: Settings) {
  const clock = settings.clock
  const now = await $.clock.now()
  const zone = await zoneOf($)
  const usage = await $.session.usage()
  const turns = await read($, turnsAtom)
  const tools = await read($, toolsAtom)
  const days = await read($, daysAtom)
  const totals = tokenTotals(turns)
  const lines = [
    `Chronicle · ${fmtDate(now, zone, clock)} ${fmtTime(now, zone, clock)} · ${zoneLabel(zone, now)}`,
    `Session: started ${fmtWhen(usage.startedAt, now, zone, clock)}, running ${fmtDur(now - usage.startedAt)}, ${await $.session.turns()} prompts, ${turns.length} turns recorded`,
  ]
  if (usage.cost) lines.push(`Cost: ${fmtUsd(usage.cost.usd)} this session · ${fmtUsd(usage.cost.usd / Math.max((now - usage.startedAt) / HOUR, 1 / 60))}/h`)
  const today = days[dayKey(now, zone)]
  if (today) lines.push(`Today: ${fmtUsd(today.usd)} over ${today.turns} turns in ${today.sessions.length} session(s)`)
  lines.push(`Context: ${usage.context.percent !== undefined ? pct(usage.context.percent) : '–'} · ${fmtTok(usage.context.tokens ?? 0)} / ${fmtTok(usage.context.window)} tokens`)
  for (const limit of usage.rateLimits) {
    const p = pace(limit, now)
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
    lines.push(`${limitName(limit.kind)} limit: ${pct(limit.percentUsed)}${resetsAt !== undefined ? `, resets ${fmtWhen(resetsAt, now, zone, clock)} (in ${fmtDur(resetsAt - now)})` : ''}${p !== undefined ? `, on pace for ~${pct(p)}` : ''}`)
  }
  lines.push(`Tokens: ${fmtTok(totals.input)} in · ${fmtTok(totals.cacheRead)} cache read · ${fmtTok(totals.cacheWrite)} cache write · ${fmtTok(totals.output)} out · cache hit ${pct(totals.hit)}`)
  const top = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 8)
  if (top.length) lines.push(`Tools: ${top.map(([n, c]) => `${n} ${c}`).join(', ')}`)
  return lines.join('\n')
}

async function todayReport($: $, settings: Settings) {
  const now = await $.clock.now()
  const zone = await zoneOf($)
  await loadDays($)
  const days = await read($, daysAtom)
  const lines = [`Spend by day (all sessions on this machine) · ${zoneLabel(zone, now)}`]
  for (let i = 0; i < 7; i++) {
    const at = now - i * DAY
    const d = days[dayKey(at, zone)]
    lines.push(`${fmtDay(at, zone, settings.clock).padEnd(11)} ${fmtUsd(d?.usd ?? 0).padStart(8)}  ${d?.turns ?? 0} turns · ${d?.sessions.length ?? 0} sessions`)
  }
  return lines.join('\n')
}

async function zoneReport($: $) {
  const now = await $.clock.now()
  const { zone, source } = await zoneSetting($)
  const from =
    source === 'setting' ? 'the timezone setting' : source === 'env' ? 'the CHRONICLE_TZ variable' : source === 'system' ? "this machine's time zone" : source === 'probe' ? "this machine's UTC offset" : 'nothing (falling back to UTC)'
  const hint = source === 'utc' ? '\nSet one with the "timezone" option (e.g. Europe/Berlin or +02:00), or the CHRONICLE_TZ environment variable.' : ''
  return `Times are shown in ${zoneLabel(zone, now)}, from ${from}.${hint}`
}

const HELP = [
  'Chronicle commands:',
  '  /chronicle          open the usage dashboard',
  '  /chronicle report   this session’s usage as text',
  '  /chronicle today    spend per day for the last week',
  '  /chronicle tz       which time zone times are shown in',
  '  /chronicle close    close the dashboard',
].join('\n')

// ─── hooks ───────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const clock = settings.clock
  fallbackZone = quickZone(settings.timezone)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'chronicle',
      description: 'Usage dashboard: cost, burn rate, context, rate limits, tokens, history',
      argumentHint: '[report | today | tz | close | help]',
    })
    // a zone at once, so the first rows draw in it; boot settles the rest
    await update($, zoneAtom, () => fallbackZone)

    void boot($, settings).catch(() => {})

    $.clock.every(30_000, () => {
      void update($, tickAtom, n => n + 1)
      void statusLine($, settings).catch(() => {})
    })
    return result
  })

  on('command.run', { command: 'chronicle' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Chronicle closed.' }
    }
    if (arg === 'report') return { text: await report($, settings) }
    if (arg === 'today' || arg === 'days') return { text: await todayReport($, settings) }
    if (arg === 'tz' || arg === 'timezone' || arg === 'zone') return { text: await zoneReport($) }
    if (arg === 'help' || arg === '?') return { text: HELP }
    void refreshBreakdown($).catch(() => {})
    const opened = await $.ui.open({ id: PANE, title: 'Chronicle' })
    return { text: opened.isPlaced ? 'Chronicle opened.' : `Chronicle is open but not shown: ${opened.reason}` }
  })

  // Every row the conversation keeps: stamp the prompts and the reply blocks.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && (e.door === 'prompt' || e.door === 'delivery' || e.door === 'response')) {
      try {
        await stampRow($, e.uuid, e.door === 'response' ? 'assistant' : 'user', await $.clock.now())
      } catch {}
    }
    return stored
  })

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, marksAtom, m => ({ ...m, turnStartedAt: now, turnTools: 0 }))
    } catch {}
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    try {
      const name = String(e.tool)
      await update($, toolsAtom, t => ({ ...t, [name]: (t[name] ?? 0) + 1 }))
      if (e.agentId === undefined) await update($, marksAtom, m => ({ ...m, turnTools: m.turnTools + 1 }))
    } catch {}
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      const now = await $.clock.now()
      const zone = await zoneOf($)
      const usage = await $.session.usage()
      const marks = await read($, marksAtom)
      const total = usage.cost?.usd
      const u = e.usage
      const turn: TurnRecord = {
        at: now,
        durationMs: e.durationMs,
        usd: total !== undefined ? Math.max(0, total - (marks.lastUsd ?? 0)) : 0,
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
        model: u?.model ?? (await $.session.model()),
        tools: marks.turnTools,
        reason: e.reason,
      }
      if (usage.context.percent !== undefined) turn.contextPercent = usage.context.percent
      if (usage.context.tokens !== undefined) turn.contextTokens = usage.context.tokens

      await update($, turnsAtom, list => [...list, turn].slice(-500))
      await update($, marksAtom, m => ({ ...m, lastUsd: total ?? m.lastUsd, turnEndedAt: now }))
      await update($, meterAtom, () => toMeter(now, usage))
      void recordDay($, turn).catch(() => {})
      void refreshBreakdown($).catch(() => {})
      void statusLine($, settings).catch(() => {})

      if (settings.footer !== 'off' && settings.stamps !== 'off' && settings.stamps !== 'prompts') {
        const summary = summaryLine(turn, now, zone, settings)
        const since = marks.turnStartedAt ?? now - e.durationMs
        if (!(await attachSummary($, since, summary))) {
          $.clock.after(1500, () => void attachSummary($, since, summary).catch(() => {}))
        }
      }
    } catch {}
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const now = await $.clock.now()
      const meter = toMeter(now, e)
      await update($, meterAtom, () => meter)
      await alerts($, meter, now, settings)
      await statusLine($, settings)
    } catch {}
    return result
  })

  // ── timestamps on the transcript ──

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (settings.stamps === 'off' || settings.stamps === 'replies') return next(e)
    const { value: stamp } = await $.state.get(memberOf(STAMP, e))
    if (stamp === undefined) return next(e)
    const idle = settings.showElapsed && stamp.gapMs !== undefined && stamp.gapMs >= IDLE_NOTE_MS ? ` · ${fmtDur(stamp.gapMs)} later` : ''
    return next({ ...e, props: { ...e.props, text: `[${await label($, stamp, clock)}${idle}]  ${e.props.text}` } })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (settings.stamps === 'off' || settings.stamps === 'prompts') return next(e)
    const { value: stamp } = await $.state.get(memberOf(STAMP, e))
    if (stamp === undefined) {
      const marks = await read($, marksAtom)
      const isLive = (marks.turnStartedAt ?? 0) > (marks.turnEndedAt ?? 0)
      if (isLive && !firstSeen.has(e.requestId)) firstSeen.set(e.requestId, await $.clock.now())
      queueSync($)
      return next(e)
    }
    const after = settings.showElapsed && stamp.gapMs !== undefined ? ` · +${fmtDur(stamp.gapMs)}` : ''
    const footer = stamp.summary && settings.footer !== 'off' ? `\n\n\`${stamp.summary}\`` : ''
    return next({ ...e, props: { ...e.props, text: `\`${await label($, stamp, clock)}${after}\`\n\n${e.props.text}${footer}` } })
  })

  // ── the dashboard ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tickAtom)
    const view = await read($, viewAtom)
    const { zone } = await zoneSetting($)
    const turns = await read($, turnsAtom)
    const tools = await read($, toolsAtom)
    const meter = await read($, meterAtom)
    const breakdown = await read($, breakdownAtom)
    const days = await read($, daysAtom)
    const now = await $.clock.now()
    const usage = await $.session.usage()

    const width = e.props.bodyColumns
    const barWidth = Math.max(8, Math.min(24, width - 46))
    const runMs = now - usage.startedAt
    const usd = usage.cost?.usd ?? sum(turns.map(t => t.usd))
    const totals = tokenTotals(turns)
    const durations = turns.map(t => t.durationMs)
    const genMs = sum(durations)

    const Row = (props: { label: string; children: any }) => (
      <Box flexDirection="row">
        <Box width={11} flexShrink={0}>
          <Text color="claude" bold>{props.label}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1}>{props.children}</Box>
      </Box>
    )

    const Tab = (props: { id: View; label: string; hotkey: string }) => (
      <Button key={`tab-${props.id}`} label={props.label} hotkey={props.hotkey} variant={view === props.id ? 'primary' : 'secondary'} onPress={() => update($, viewAtom, () => props.id)} />
    )

    const turnLine = (t: TurnRecord) => (
      <Text dimColor={t.reason !== 'answer'}>
        {fmtWhen(t.at, now, zone, clock).padEnd(clock.is12h ? 11 : 8)} {fmtDur(t.durationMs).padStart(7)} {fmtUsd(t.usd).padStart(7)} ↓{fmtTok(t.output).padEnd(5)} {String(t.tools).padStart(2)} tools{t.contextPercent !== undefined ? ` · ctx ${pct(t.contextPercent)}` : ''}
      </Text>
    )

    let body: any
    if (view === 'history') {
      const rows = Array.from({ length: 14 }, (_, i) => now - i * DAY)
      const totalsByRow = rows.map(at => days[dayKey(at, zone)])
      const maxUsd = Math.max(0.0001, ...totalsByRow.map(d => d?.usd ?? 0))
      const inLast = (n: number) => sum(rows.slice(0, n).map(at => days[dayKey(at, zone)]?.usd ?? 0))
      const week = inLast(7)
      const prevWeek = sum(Array.from({ length: 7 }, (_, i) => days[dayKey(now - (i + 7) * DAY, zone)]?.usd ?? 0))
      const all = Object.values(days)
      const trend = prevWeek > 0 ? ` · ${week >= prevWeek ? '▲' : '▼'} ${pct(Math.abs(week / prevWeek - 1) * 100)} vs the week before` : ''
      body = (
        <Box flexDirection="column">
          <Row label="This week">
            <Text>
              <Text bold>{fmtUsd(week)}</Text> · {fmtUsd(week / 7)}/day{trend}
            </Text>
            <Text dimColor>
              {all.length} days on record · {fmtUsd(sum(all.map(d => d.usd)))} in all · {sum(all.map(d => d.turns))} turns
            </Text>
          </Row>
          <Text> </Text>
          {rows.map((at, i) => {
            const d = totalsByRow[i]
            const isToday = i === 0
            return (
              <Text dimColor={!d}>
                <Text bold={isToday}>{fmtDay(at, zone, clock).padEnd(11)}</Text>
                <Text color="claude">{bar(((d?.usd ?? 0) / maxUsd) * 100, barWidth)}</Text> {fmtUsd(d?.usd ?? 0).padStart(7)} · {String(d?.turns ?? 0).padStart(3)} turns · {d?.sessions.length ?? 0} sessions
              </Text>
            )
          })}
          <Text dimColor>Spend is counted per machine (a cloud project keeps its own).</Text>
        </Box>
      )
    } else if (view === 'turns') {
      const models: Record<string, number> = {}
      for (const t of turns) models[t.model] = (models[t.model] ?? 0) + 1
      const topTools = Object.entries(tools).sort((a, b) => b[1] - a[1])
      const toolCount = sum(topTools.map(([, c]) => c))
      const sparkTurns = turns.slice(-Math.max(8, Math.min(48, width - 24)))
      body = (
        <Box flexDirection="column">
          <Row label="Turns">
            <Text>
              {turns.length ? `${turns.length} · avg ${fmtDur(genMs / turns.length)} · longest ${fmtDur(Math.max(...durations))}` : 'none yet'}
            </Text>
            {turns.length > 0 && (
              <Text dimColor>
                working {fmtDur(genMs)} ({pct(runMs > 0 ? (genMs / runMs) * 100 : 0)} of the session) · {genMs > 0 ? `${Math.round(totals.output / (genMs / 1000))} tok/s` : ''}
              </Text>
            )}
          </Row>
          {sparkTurns.length > 1 && (
            <Row label="Duration">
              <Text>
                <Text color="claude">{spark(sparkTurns.map(t => t.durationMs))}</Text>
                <Text dimColor> last {sparkTurns.length}</Text>
              </Text>
            </Row>
          )}
          {Object.keys(models).length > 0 && (
            <Row label="Models">
              <Text dimColor>{Object.entries(models).map(([m, n]) => `${m} ×${n}`).join(' · ')}</Text>
            </Row>
          )}
          <Row label="Tools">
            <Text wrap="wrap">
              {toolCount === 0 ? 'none yet' : `${toolCount} calls · ` + topTools.slice(0, 12).map(([n, c]) => `${n.replace(/^mcp__[^_]+__/, '')} ${c}`).join(' · ')}
            </Text>
          </Row>
          <Text> </Text>
          {turns.length > 0 && <Text bold>Recent turns</Text>}
          {turns.slice(-15).reverse().map(turnLine)}
        </Box>
      )
    } else {
      const perHour = runMs > 6 * MIN ? usd / (runMs / HOUR) : undefined
      const left = turnsLeft(turns, meter, breakdown)
      const today = days[dayKey(now, zone)]
      const ctxPercent = usage.context.percent ?? 0
      const sparkTurns = turns.slice(-Math.max(8, Math.min(40, width - 20)))
      body = (
        <Box flexDirection="column">
          <Row label="Session">
            <Text>
              started {fmtWhen(usage.startedAt, now, zone, clock)} · running {fmtDur(runMs)}
            </Text>
            <Text dimColor>
              {await $.session.turns()} prompts · {turns.length} turns · {await $.session.model()}
            </Text>
          </Row>

          <Row label="Cost">
            <Text>
              <Text bold>{fmtUsd(usd)}</Text>
              {perHour !== undefined ? ` · ${fmtUsd(perHour)}/h` : ''}
              {turns.length ? ` · avg ${fmtUsd(sum(turns.map(t => t.usd)) / turns.length)}/turn` : ''}
              {turns.length ? ` · last ${fmtUsd(turns.at(-1)?.usd ?? 0)}` : ''}
            </Text>
            <Text dimColor>
              today {fmtUsd(today?.usd ?? 0)} across {today?.sessions.length ?? 0} sessions, {today?.turns ?? 0} turns
            </Text>
            {sparkTurns.length > 1 && (
              <Text>
                <Text color="claude">{spark(sparkTurns.map(t => t.usd))}</Text>
                <Text dimColor> cost per turn, last {sparkTurns.length}</Text>
              </Text>
            )}
          </Row>

          <Row label="Context">
            <Text>
              <Text color={level(ctxPercent)}>{bar(ctxPercent, barWidth)}</Text> {pct(ctxPercent)} · {fmtTok(usage.context.tokens ?? 0)} / {fmtTok(usage.context.window)}
            </Text>
            <Text dimColor>
              {breakdown?.autoCompactAt !== undefined ? `auto-compact at ${fmtTok(breakdown.autoCompactAt)}` : 'auto-compact off'}
              {left !== undefined ? ` · ~${left} turns left at recent growth` : ''}
            </Text>
            {breakdown && breakdown.categories.length > 0 && (
              <Text dimColor wrap="wrap">
                {breakdown.categories.slice(0, 5).map(c => `${c.name} ${fmtTok(c.tokens)}`).join(' · ')}
              </Text>
            )}
          </Row>

          <Row label="Limits">
            {usage.rateLimits.length === 0 && <Text dimColor>No rate-limit reading yet (API key, or before the first reply).</Text>}
            {usage.rateLimits.map(limit => {
              const p = pace(limit, now)
              const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
              return (
                <Box flexDirection="column">
                  <Text>
                    {limitShort(limit.kind).padEnd(3)}<Text color={level(limit.percentUsed)}>{bar(limit.percentUsed, barWidth)}</Text> {pct(limit.percentUsed)}
                  </Text>
                  <Text dimColor>
                    {'   '}
                    {resetsAt !== undefined ? `resets ${fmtWhen(resetsAt, now, zone, clock)} (in ${fmtDur(resetsAt - now)})` : 'reset time unknown'}
                    {p !== undefined ? ' · on pace for ' : ''}
                    {p !== undefined && <Text color={level(p)}>~{pct(p)}</Text>}
                  </Text>
                </Box>
              )
            })}
          </Row>

          <Row label="Tokens">
            <Text>
              ↑ {fmtTok(totals.allIn)} in · ↓ {fmtTok(totals.output)} out · cache hit {pct(totals.hit)}
            </Text>
            <Text dimColor>
              {fmtTok(totals.input)} fresh · {fmtTok(totals.cacheRead)} cache read · {fmtTok(totals.cacheWrite)} cache write
            </Text>
          </Row>

          {turns.length > 0 && <Text> </Text>}
          {turns.length > 0 && <Text bold>Last turns</Text>}
          {turns.slice(-3).reverse().map(turnLine)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {fmtDate(now, zone, clock)} · {fmtTime(now, zone, clock, false)}
          </Text>
          <Text dimColor>{zoneLabel(zone, now)}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Tab id="overview" label="Overview" hotkey="1" />
          <Tab id="history" label="History" hotkey="2" />
          <Tab id="turns" label="Turns" hotkey="3" />
        </Box>
        <Text> </Text>
        {body}
        <Text> </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={async () => {
            await refreshBreakdown($)
            await loadDays($)
            await update($, tickAtom, n => n + 1)
          }} />
          <Button key="report" label="Copy report" hotkey="c" onPress={async () => {
            const copied = await $.ui.copy({ text: await report($, settings), surface: e.surface })
            $.ui.toast(copied.isCopied ? 'Usage report copied' : `Could not copy: ${copied.reason}`)
          }} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}


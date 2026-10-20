/** When a transcript row was stored, and what is worth saying about it. */
export type Stamp = {
  at: number
  role: 'user' | 'assistant'
  /** user: time since the previous reply; assistant: time since the prompt */
  gapMs?: number
  /** first row of the session, or first row on a new local day */
  isNewDay?: boolean
  /** the turn's usage line, on its last reply block */
  summary?: string
}

export type TurnRecord = {
  at: number
  durationMs: number
  usd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model: string
  tools: number
  contextPercent?: number
  contextTokens?: number
  reason: string
}

export type Meter = {
  at: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd?: number
}

export type Breakdown = {
  at: number
  categories: { name: string; tokens: number }[]
  autoCompactAt?: number
  total: number
  max: number
}

export type Marks = {
  lastPromptAt?: number
  lastReplyAt?: number
  lastDay?: string
  turnStartedAt?: number
  turnEndedAt?: number
  turnTools: number
  lastUsd?: number
}

export type DayTotal = { usd: number; turns: number; output: number; sessions: string[] }

/** The zone times are shown in, and where it came from. */
export type ZoneSetting = {
  zone: { kind: 'iana'; name: string } | { kind: 'offset'; minutes: number }
  source: 'setting' | 'env' | 'system' | 'probe' | 'utc'
}

export type View = 'overview' | 'history' | 'turns'

declare module 'claude-code' {
  interface PluginState {
    chronicle: {
      stamp: StateFamily<Stamp>
      turns: TurnRecord[]
      tools: Record<string, number>
      meter: Meter | null
      breakdown: Breakdown | null
      marks: Marks
      zone: ZoneSetting
      view: View
      tick: number
      alerted: string[]
      days: Record<string, DayTotal>
    }
  }
}

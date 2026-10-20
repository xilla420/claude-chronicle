import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.parse('2026-10-12T12:00:00Z')

async function has(ui: { findAll: (q: never) => Promise<{ text?: string }[]> }, pattern: RegExp, surface: string) {
  const texts = (await ui.findAll({ type: 'Text' } as never)).map(t => t.text ?? '')
  if (!texts.some(t => pattern.test(t))) throw new Error(`${surface}: no text matches ${pattern}; drawn: ${JSON.stringify(texts.slice(0, 40))}`)
}

test('the dashboard draws on terminal and desktop, every tab, and a turn lands in it', { options: { timezone: 'UTC' } }, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(T0)
  mock.session(on)
  mock.store(on)
  let usd = 0
  on('session.usage', () => ({ value: {
    startedAt: T0 - 90 * 60_000,
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 37, resetsAt: new Date(T0 + 2 * 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 12.5, resetsAt: new Date(T0 + 4 * 86_400_000).toISOString() },
    ],
    cost: { usd },
  } }))
  on('session.turns', () => ({ value: 3 }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }) as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never).catch(() => {})
  usd = 0.42
  await clock.advance(12_000)
  const done = await $.turn.complete({
    answer: 'done',
    durationMs: 12_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' },
  })
  expect(done.text).toBe('done')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'chronicle',
      surface,
      component: 'Pane',
      requestId: 'chronicle',
      props: { title: 'Chronicle', isFocused: false, bodyColumns: 90, placement: 'dock' } as never,
    })
    await has(ui, /Mon 12 Oct 2026/, surface)
    await has(ui, /on pace for/, surface)
    await has(ui, /\$0\.42/, surface)
    await ui.press({ key: 'tab-history' })
    await has(ui, /This week/, surface)
    await ui.press({ key: 'tab-turns' })
    await has(ui, /Recent turns/, surface)
    await has(ui, /Bash 1/, surface)
    await ui.press({ key: 'tab-overview' })
    await has(ui, /Last turns/, surface)
    await ui.unmount()
  }
})

import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.parse('2026-10-12T10:05:07Z')

test('prompts and replies are drawn with their time, the date on a new day', { options: { timezone: 'UTC' } }, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(T0)
  mock.session(on)

  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })

  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'prompt-1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })
  await clock.advance(53_000)
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'reply-1',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const user = await $.ui.mount({
      plugin: 'chronicle',
      surface,
      component: 'UserMessage',
      requestId: 'prompt-1',
      props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
    })
    expect((await user.find({ type: 'Text' }))?.text).toBe('[Mon 12 Oct 2026 · 10:05:07]  hello')
    await user.unmount()

    const reply = await $.ui.mount({
      plugin: 'chronicle',
      surface,
      component: 'AssistantMessage',
      requestId: 'reply-1',
      props: { text: 'hi there', isFirstOfReply: true },
    })
    expect((await reply.find({ type: 'Text' }))?.text).toBe('`10:06:00 · +53s`\n\nhi there')
    await reply.unmount()
  }
})

test('a row with no stamp is drawn as the engine has it', { options: { timezone: 'UTC' } }, async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'chronicle',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'unknown',
    props: { text: 'old row', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('old row')
})

test('the stamps setting keeps prompts plain when only replies are stamped', { options: { timezone: 'UTC', stamps: 'replies' } }, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(T0)
  mock.session(on)
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'prompt-2',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'plain' }] },
  })
  const ui = await $.ui.mount({
    plugin: 'chronicle',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'prompt-2',
    props: { text: 'plain', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('plain')
})

test('a 12-hour clock without seconds, in a named zone', { options: { timezone: 'Europe/Berlin', clock: '12h', seconds: false } }, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(T0)
  mock.session(on)
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'prompt-3',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hi' }] },
  })
  const ui = await $.ui.mount({
    plugin: 'chronicle',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'prompt-3',
    props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('[Mon 12 Oct 2026 · 12:05 PM]  hi')
})

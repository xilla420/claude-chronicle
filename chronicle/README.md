# Chronicle

A Claude Code mod that puts time and usage where you can see them.

- **Timestamps on every message.** Your prompts get `[14:32:05]`, replies get `` `14:32:58 · +53s` `` (time since your prompt). After a break of 15+ minutes a prompt says `· 2h 05m later`.
- **Dates in the right places.** The full date shows on a session's first message, the first message after midnight, and any message not from today.
- **A usage line on each reply.** The turn's last reply ends with
  `⏱ done 14:33:01 · took 12.4s · $0.042 · ↑43k ↓850 tok · cache 94% · ctx 23% · 7 tools`
- **A live status line.** `14:33 · $1.84 ($1.67/h) · ctx 48% · 5h 23% ↻17:00 · 7d 8%`
- **Alerts.** At 50/80/95% of a rate limit, when you're on pace to run out before it resets, and at 75/90% context.
- **A dashboard,** `/chronicle`, with three tabs:
  - *Overview*: cost and burn rate, context fill and turns left before auto-compact, rate limits with reset countdowns and where you're on pace to end up, tokens and cache hit rate.
  - *History*: spend per day for two weeks across all sessions, week-over-week trend.
  - *Turns*: durations, models, tools, the last 15 turns.

Time zones follow daylight saving (`Europe/Berlin` is UTC+2 in summer and UTC+1 in winter).

## Install

In a Claude Code terminal:

```
/plugin install chronicle --marketplace xilla420/claude-chronicle
```

Answer `y` to add the marketplace, then pick a scope (user is the usual choice).

Or from your shell:

```bash
claude plugin marketplace add xilla420/claude-chronicle
claude plugin install chronicle@xilla420 --scope user
```

## Commands

| Command | What it does |
| --- | --- |
| `/chronicle` | Open the dashboard |
| `/chronicle report` | This session's usage as text (also readable by Claude) |
| `/chronicle today` | Spend per day for the last week |
| `/chronicle tz` | Which time zone times are shown in, and why |
| `/chronicle close` | Close the dashboard |

## Options

Set them with `/plugin configure chronicle@xilla420`, or under `pluginConfigs` in `settings.json`.

| Option | Default | Values |
| --- | --- | --- |
| `timezone` | `auto` | `auto`, an IANA name (`Europe/Berlin`), `UTC`, or an offset (`+02:00`, `UTC-5`) |
| `clock` | `24h` | `24h`, `12h` |
| `seconds` | `true` | show seconds in message timestamps |
| `dateFormat` | `weekday` | `weekday` (Mon 12 Oct 2026), `iso` (2026-10-12), `us` (Mon, Oct 12, 2026), `eu` (Mon 12.10.2026) |
| `stamps` | `both` | `both`, `prompts`, `replies`, `off` |
| `showElapsed` | `true` | `+12s` on replies, `2h later` on prompts after a break |
| `turnFooter` | `true` | the usage line on each turn's last reply |
| `footerStyle` | `full` | `full`, `compact` |
| `statusLine` | `true` | the live status line |
| `statusStyle` | `full` | `full`, `compact` |
| `alerts` | `true` | rate-limit, pace and context alerts |

The time zone can also come from the `CHRONICLE_TZ` environment variable, which is handy where you can't set options, like a cloud environment.

## Where it works

- **Local sessions** in the desktop app's Code tab and the terminal: everything.
- **Cloud sessions** (Claude Code on the web, Projects threads): they run on UTC in a VM, so set `timezone` or `CHRONICLE_TZ`. Panes don't draw in cloud sessions, so the dashboard isn't available there; `/chronicle report` and `/chronicle today` still work. Spend history is kept per machine.
- Regular Chat conversations aren't Claude Code sessions, so mods don't reach them.

## Development

```bash
claude plugin validate chronicle
claude plugin test chronicle
```

The hooks module is `chronicle/hooks/register.tsx`; time and formatting live in `chronicle/hooks/time.ts`.

## License

MIT

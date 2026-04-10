# Autobeat v1.2.0 — Terminal Dashboard & Agent Config Passthrough

A rich interactive terminal dashboard for at-a-glance visibility across loops, tasks, schedules, and orchestrations, plus per-agent `baseUrl` and `model` configuration for custom API endpoints and model selection across Claude, Codex, and Gemini.

---

## Terminal Dashboard

A new interactive terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React for terminal UIs) surfaces the state of your Autobeat runtime in one place. Requires a TTY.

```bash
beat dashboard
# or the shorter alias
beat dash
```

### Four Panels

The dashboard splits the screen into four panels, each showing the most recent items of its entity type:

- **Loops** — active and historical loop iterations with scores and status
- **Tasks** — queued, running, completed, failed, and cancelled tasks
- **Schedules** — active, paused, and completed cron/one-time schedules
- **Orchestrations** — running and completed autonomous orchestrations

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle focus between panels |
| `1` – `4` | Jump directly to panel 1-4 |
| `↑` / `↓` or `j` / `k` | Move selection within focused panel |
| `Enter` | Drill into the selected item (detail view) |
| `Esc` | Back out of a detail view |
| `f` | Cycle the filter for the focused panel |
| `r` | Refresh data |
| `q` | Quit |

### Per-Panel Filters

Each panel cycles through only its valid statuses, so task filters don't bleed into schedule filters. Hitting `f` on the Tasks panel rotates through task statuses; hitting `f` on the Schedules panel rotates through schedule statuses. The active filter is shown in the panel header.

### Detail Views

Pressing `Enter` on a selected item opens a detail view with entity-specific field rendering:

- **Task detail** — prompt, status, exit code, worker PID, durations, dependencies, output excerpt
- **Loop detail** — strategy, exit condition, iteration history with scores, pause state
- **Schedule detail** — cron/one-time config, timezone, execution history, next run time
- **Orchestration detail** — goal, plan steps, guardrails, current iteration, worker state

### Smart Empty States

When a filter hides every item in a panel, the EmptyState shows the true count ("12 tasks hidden by filter") rather than an ambiguous "nothing to show". Long lists display truncation indicators when there are more items than the panel can render.

---

## Agent BaseUrl & Model Passthrough

Every registered agent can now be configured with a custom `baseUrl` and default `model`, letting you point Autobeat at self-hosted gateways, proxies, or alternate providers while keeping the same agent adapters.

### Per-Agent Config in `~/.autobeat/config.json`

```json
{
  "defaultAgent": "claude",
  "agents": {
    "claude": {
      "baseUrl": "https://my-proxy.example.com",
      "model": "claude-sonnet-4-5"
    },
    "codex": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5"
    }
  }
}
```

### CLI `--model` Flag

Both `beat run` and `beat orchestrate` accept a `--model` / `-m` flag to override the configured default per invocation:

```bash
beat run "Refactor the auth module" --agent claude --model claude-sonnet-4-5
beat orchestrate "Ship feature X" --agent codex --model gpt-5 -m gpt-5
```

### Provider Env Var Injection

When an agent is spawned, Autobeat injects the configured `baseUrl` into the provider-specific environment variable:

| Agent | Env var |
|-------|---------|
| `claude` | `ANTHROPIC_BASE_URL` |
| `codex` | `OPENAI_BASE_URL` |
| `gemini` | `GEMINI_BASE_URL` |

**User env vars take precedence**: if `ANTHROPIC_BASE_URL` is already set in your shell, Autobeat will not override it. This keeps ad-hoc overrides and per-shell configs working.

### Claude Experimental-Betas Auto-Disable

When a custom `baseUrl` is configured for the Claude agent, Autobeat automatically disables the experimental beta headers that the Claude CLI would normally send. This prevents "unsupported beta header" failures when routing through proxies or alternate endpoints that don't implement the latest experimental betas.

Autobeat also prints a warning when `baseUrl` is set on Claude without a detected API key, since most proxies still require authentication.

### Extended MCP Tools

- **`ConfigureAgent`** now accepts `baseUrl` and `model` parameters for the `set` action
- **`ListAgents`** now returns each agent's configured `baseUrl` and `model`

---

## Architecture

### Dashboard

- **Hooks**: `useDashboardData` (periodic fetch from repositories) and `useKeyboard` (centralized keybinding dispatch)
- **Components**: `Panel`, `ScrollableList`, `Header`, `Footer`, `Field`, `StatusBadge`, `EmptyState`, `TableRow`
- **Views**: main four-panel layout plus detail views per entity type (`task-detail`, `loop-detail`, `schedule-detail`, `orchestration-detail`)
- **Pure formatting**: `format.ts` contains pure functional formatters for durations, timestamps, truncation, and status colors — no React, no I/O
- **Data flow**: repositories → `useDashboardData` → focused panel state → views

### Agent Config

`model` is threaded end-to-end through the delegation pipeline:

- **Domain** — `model?: string` added to `Task` and `Orchestration` domain types
- **MCP** — `ConfigureAgent`/`ListAgents` accept and return `baseUrl`/`model`; `DelegateTask`/`CreateOrchestrator` accept per-call `model`
- **CLI** — `--model` / `-m` flag on `beat run` and `beat orchestrate`
- **Spawn pipeline** — `base-agent-adapter` reads the resolved `model` and injects `baseUrl` into the spawn env
- **Database** — `model` persisted on both tasks and orchestrations for audit and retry

---

## Database

**Migration 16** adds a `model` column to both the `tasks` and `orchestrations` tables. Applied automatically on startup. Backward compatible — `NULL` is allowed, and existing rows keep their behavior unchanged.

---

## What's Changed Since v1.1.0

- **feat**: agent baseUrl & model passthrough ([#130](https://github.com/dean0x/autobeat/pull/130))
- **feat**: dashboard ([#131](https://github.com/dean0x/autobeat/pull/131))

---

## Migration Notes

- **Fully additive**: No breaking changes. No existing APIs, CLI commands, or MCP tools were changed or removed.
- **Database**: Migration 16 auto-applies on startup. No user action needed.
- **Existing configs**: Work unchanged. `baseUrl` and `model` are optional additions. Omit them and Autobeat behaves exactly as in v1.1.0.
- **TTY requirement**: `beat dashboard` requires an interactive terminal. It will refuse to run in piped or non-interactive contexts.

---

## Installation

```bash
npm install -g autobeat@1.2.0
```

Or use npx for MCP integration:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.2.0", "mcp", "start"]
    }
  }
}
```

---

## Links

- NPM Package: https://www.npmjs.com/package/autobeat
- Documentation: https://github.com/dean0x/autobeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/autobeat/issues

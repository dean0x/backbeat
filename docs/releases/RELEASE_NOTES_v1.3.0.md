# Autobeat v1.3.0 — Dashboard Redesign, Eval Redesign & Reliability

A complete rethink of the terminal dashboard: two purpose-built views (Metrics and Workspace), live agent output streaming, cost and token tracking for Claude agents, responsive layout, and orchestrator attribution wired through the full stack. Plus: three evaluation modes for loops (feedforward, judge, schema), atomic PID file management, and a suite of reliability improvements targeting testability and correctness in the loop/schedule execution path.

---

## Highlights

- **Two-view dashboard**: Metrics view with live tiles and activity feed; Workspace view with per-task streaming panels
- **Live agent output streaming**: Output appears in the dashboard within 1-2 seconds
- **Cost and token tracking**: Captures and aggregates token usage and USD cost for Claude agents
- **Cancel cascade**: `c` on an orchestration cancels it and all attributed child tasks in one command
- **Responsive layout**: Adapts to terminal size; degrades gracefully on narrow or small terminals
- **Orchestrator attribution**: Sub-task spawning wired through both CLI and MCP paths
- **Three evaluation modes**: `feedforward` (default — findings without a stop decision), `judge` (two-phase eval+judge with TOCTOU-safe file decisions), and `schema` (deterministic Claude `--json-schema` eval)
- **Atomic PID file locking**: Schedule executor uses O_EXCL file creation to prevent double-execution races
- **SpawnOptions refactor**: `AgentAdapter.spawn()` now accepts a named options object instead of 6 positional parameters
- **Extracted pure functions**: `refetchAfterAgentEval`, `handleStopDecision`, `buildEvalPromptBase`, `checkActiveSchedules`, `registerSignalHandlers`, `startIdleCheckLoop` — all fully unit-tested

---

## Metrics View

The main view (`m` / `v` from workspace) is now a tile-based metrics dashboard:

```
┌─────────────────────────────────────────────────────────────────┐
│  Resources      │  Cost (24h)        │  Throughput             │
│  CPU: 34%       │  $0.042 total      │  12 tasks/hr            │
│  RAM: 1.2 GB    │  claude-3-5-sonnet │  4 loops/hr             │
│                 │  Top: orch-abc $0.03│  Success: 92%           │
├─────────────────┴───────────────────���┴─────────────────────────┤
│  Activity Feed                        │  Entity Counts          │
│  14:22  task  abc123def   completed   │  Orchestrations  2 / 0  │
│  14:21  orch  xyz789abc   planning    │  Loops           5 / 1  │
│  14:20  loop  def456xyz   iteration 3 │  Tasks          18 / 3  │
│  14:18  sched qrs012uvw   triggered   │  Schedules       3 / 0  │
└───────────────────────────────────────┴─────────────────────────┘
```

- **Resources tile**: CPU and memory from system metrics, polled every 2s
- **Cost tile**: 24h rolling aggregate, top orchestrations by cost
- **Throughput tile**: tasks/hr, loops/hr, success rate, avg duration
- **Activity feed**: Time-sorted cross-entity feed with keyboard navigation
- **Counts panel**: Running / failed counts per entity kind

### Activity Feed Navigation

Tab cycles into the activity feed after the four panel types:
`loops → tasks → schedules → orchestrations → activity → (wrap)`

| Key | Action |
|-----|--------|
| `Tab` (from orchestrations) | Focus activity feed |
| `↑` / `↓` or `k` / `j` | Navigate feed rows |
| `Enter` | Drill into detail view for selected entry |
| `Esc` | Return to panel grid focus |
| `Shift+Tab` (from loops) | Focus activity feed (reverse cycle) |

---

## Workspace View

The workspace view (`w` / `v` from metrics) shows a live task grid for a selected orchestration:

```
┌──────────────────┬───────────────────────────────────────────────┐
│ Orchestrations   │  Task: auth-module [running]                   │
│ > orch-abc  run  │  > Analyzing existing auth implementation...   │
│   orch-def  done │  > Found 3 test files                          │
│                  │  > Creating replacement with JWT...            │
│                  ├───────────────────────────────────────────────┤
│                  │  Task: tests-suite [queued]                    │
│                  │  Waiting for auth-module                       │
└──────────────────┴───────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle: orchestration nav ↔ task grid |
| `↑` / `↓` | Navigate orchestration list (nav focus) |
| `Enter` (nav focus) | Commit selection, switch to grid focus |
| `Enter` (grid focus) | Drill into child task detail |
| `f` | Toggle fullscreen for focused task panel |
| `[` / `]` | Scroll focused task panel up / down |
| `g` | Jump to top of focused task panel (disables auto-tail) |
| `G` | Jump to bottom of focused task panel (re-engages auto-tail) |
| `c` | Cancel orchestration (nav) or child task (grid) |
| `d` | Delete focused child task (grid focus, terminal status only) |
| `PgUp` / `PgDn` | Page through task grid |
| `Esc` | Exit fullscreen → return to Metrics view |

---

## Live Agent Output Streaming

Task output now streams into Workspace task panels in near real-time.

- **Polling interval**: 1000ms by default (was 5000ms); configurable via `OUTPUT_FLUSH_INTERVAL_MS` env var
- **Ring buffer**: Each task panel holds the most recent lines; auto-tails as new output arrives
- **Per-status polling**: Stops polling completed, failed, or cancelled tasks to avoid redundant DB reads
- **Architecture**: `useTaskOutputStream` hook manages per-task polling; `OutputRepository.getOutputSince()` fetches incremental chunks

---

## Cost and Token Tracking

Claude agents now capture token usage and estimated cost automatically.

### How It Works

When a Claude task completes, `UsageCaptureHandler` reads the agent's final output, extracts the usage summary via `UsageParser`, and writes a row to `task_usage`.

Fields captured per task:
- `input_tokens`, `output_tokens`
- `cache_creation_input_tokens`, `cache_read_input_tokens`
- `total_cost_usd` (computed using Anthropic's published pricing)
- `model` (which model variant was used)
- `captured_at` (for time-window aggregates)

### Usage in Metrics View

- **Cost tile**: Shows 24h rolling aggregate and top orchestrations by total cost
- **Orchestration detail**: Shows aggregate cost for all child tasks attributed to the orchestration

### What's Not Yet Supported

Codex and Gemini agents do not yet emit a usage summary in a parseable format. Their tasks will show `$0.00` in the dashboard. A follow-up release will add per-provider cost capture.

---

## Orchestrator_id Propagation

Sub-tasks spawned by an orchestration are now attributed to it via `tasks.orchestrator_id`.

### CLI Spawn Path

When `beat run` is launched as a child of an orchestration, the orchestration ID is passed via the `AUTOBEAT_ORCHESTRATOR_ID` environment variable and written to `tasks.orchestrator_id`.

### MCP Spawn Path (Daemon-Safe)

Long-running MCP servers cannot use PID-based attribution (the orchestrator process may restart between runs). Instead, `DelegateTask` accepts `metadata.orchestratorId`:

```json
{
  "tool": "DelegateTask",
  "arguments": {
    "prompt": "Implement the user auth module",
    "metadata": {
      "orchestratorId": "orch-abc123def456"
    }
  }
}
```

Attribution is then written to `tasks.orchestrator_id` at task creation time.

---

## Cancel Cascade

Pressing `c` on a running orchestration in the Workspace nav triggers a cancel cascade:

1. The orchestration status is set to `cancelled`
2. All tasks with `orchestrator_id = <this orchestration>` that are not already terminal are also cancelled

This replaces the previous behavior where cancelling an orchestration left orphaned running tasks.

---

## Responsive Layout

The dashboard detects terminal dimensions from `process.stderr` (columns × rows) and selects a layout mode:

| Mode | Condition | Behavior |
|------|-----------|---------|
| `full` | ≥ 60 cols and ≥ 14 rows | Normal tile + panel layout |
| `narrow` | < 60 cols and ≥ 14 rows | Single-column stack, tiles only |
| `too-small` | < 14 rows (regardless of columns) | Resize prompt |

Layout is recomputed whenever the terminal is resized (SIGWINCH).

---

## Architecture

### New Modules

| Module | Purpose |
|--------|---------|
| `src/cli/dashboard/views/metrics-view.tsx` | Metrics tile layout; replaces `main-view.tsx` |
| `src/cli/dashboard/views/workspace-view.tsx` | Orchestration workspace with task grid |
| `src/cli/dashboard/use-terminal-size.ts` | Hook: subscribes to SIGWINCH, returns `{columns, rows}` |
| `src/cli/dashboard/layout.ts` | Pure layout math for metrics and workspace |
| `src/cli/dashboard/use-task-output-stream.ts` | Per-task output polling with ring buffer |
| `src/cli/dashboard/activity-feed.ts` | Pure helper: merges entity updates into sorted feed |
| `src/implementations/usage-repository.ts` | CRUD and aggregation for `task_usage` |
| `src/services/usage-parser.ts` | Extracts token/cost data from Claude output |
| `src/services/handlers/usage-capture-handler.ts` | Listens for task completion, writes usage row |

| `src/services/feedforward-evaluator.ts` | Feedforward exit condition evaluator |
| `src/services/judge-exit-condition-evaluator.ts` | Two-phase eval+judge evaluator |
| `src/services/eval-prompt-builder.ts` | Shared eval prompt context builder |
| `src/core/agents.ts` → `SpawnOptions` | Named spawn options interface |
| `tests/fixtures/eval-test-helpers.ts` | Shared eval test fixtures |

### Deleted Modules

- `src/cli/dashboard/views/main-view.tsx` — replaced by `metrics-view.tsx`. Consumers of dashboard internals must update imports.

### Event Flow

```
TaskCompleted
  → UsageCaptureHandler reads output → UsageParser → UsageRepository.upsert()

DelegateTask (MCP, with metadata.orchestratorId)
  → TaskRepository.create() with orchestrator_id
  → TaskCreated event (PersistenceHandler stores it)
```

---

## Database

**All migrations are additive and auto-applied on startup.**

| Migration | Description |
|-----------|-------------|
| v18 | `tasks.orchestrator_id TEXT` — nullable FK to `orchestrations(id)` with partial index |
| v19 | `task_usage` table — one row per task, PK/FK to tasks, cascade-deleted with task |
| v21 | `workers.last_heartbeat`, `loops.eval_type`, `loops.judge_agent`, `loops.judge_prompt` columns |
| v22 | Recreates `loops` table with CHECK constraints on `eval_type` and `judge_agent` (**full table rebuild**) |

**Back up your database before upgrading.** Migration v22 recreates the `loops` table — it is a destructive operation that cannot be rolled back without a backup.

---

## Breaking Changes

### Output flush interval default changed

`outputFlushIntervalMs` default changed from 5000ms to 1000ms. This may slightly increase database write pressure on systems with many concurrent tasks. To restore the previous default:

```bash
OUTPUT_FLUSH_INTERVAL_MS=5000 beat dashboard
```

### `main-view.tsx` removed

`src/cli/dashboard/views/main-view.tsx` has been deleted. If you import from dashboard internals directly (uncommon; dashboard is normally consumed via the CLI), update the import to `metrics-view.tsx`.

---

## Migration Notes

- **Back up your database before upgrading.** Migration v22 recreates the `loops` table — back up `~/.autobeat/autobeat.db` before running `npm install -g autobeat@1.3.0`.
- **Auto-applied**: Migrations v18, v19, v21, and v22 apply on the first `beat` command after upgrading. No manual steps needed.
- **Backward compatible**: All existing tasks, loops, schedules, and orchestrations work unchanged. New columns default to `NULL`. Existing loops with no `evalType` configured are treated as `feedforward`.
- **`AgentAdapter.spawn()` signature change**: If you have custom `AgentAdapter` implementations (not using `BaseAgentAdapter`), update `spawn(prompt, workingDirectory, ...)` to `spawn({ prompt, workingDirectory, ... })`.
- **Database size**: `task_usage` adds one small row per completed Claude task. Impact is negligible for typical workloads.

---

## New Evaluation Modes

The `evalType` field accepts three values: `'feedforward'` (default), `'judge'`, or `'schema'`. It is set per loop and stored in the `loops.eval_type` column.

### Feedforward (`evalType: 'feedforward'`) — Default

Gathers agent findings on every iteration and injects them as context into the next iteration's prompt — without making a stop/continue decision. The loop always runs to `maxIterations`.

```json
{
  "evalType": "feedforward",
  "evalPrompt": "Review the changes and note any issues for the next iteration.",
  "maxIterations": 10
}
```

**No `evalPrompt` configured?** The evaluator returns immediately with no findings (`{ decision: 'continue', feedback: undefined }`) — a pure pass-through.

### Judge (`evalType: 'judge'`)

Two-phase evaluation:

1. **Eval agent** (phase 1): runs `evalPrompt` and produces narrative findings
2. **Judge agent** (phase 2): reads findings and writes a structured JSON decision to `.autobeat-judge-task-{uuid}` in the working directory

The filename includes the full judge task ID (`task-{uuid}`) to prevent TOCTOU races. Claude's `--json-schema` is used as belt-and-suspenders when `judgeAgent: 'claude'`. If both mechanisms fail, the evaluator defaults to `continue: true`.

```json
{
  "evalType": "judge",
  "evalPrompt": "Review the test suite and identify any remaining failures.",
  "judgeAgent": "claude",
  "judgePrompt": "Based on the findings, should iteration continue? Stop when all tests pass."
}
```

### Schema (`evalType: 'schema'`)

Deterministic structured output evaluation using Claude's `--json-schema` flag. The eval agent must respond with `{"continue": true, "reasoning": "..."}`.

```json
{
  "evalType": "schema",
  "evalPrompt": "Assess whether all acceptance criteria are met.",
  "maxIterations": 5
}
```

---

## Reliability Improvements

### Atomic PID File Locking

The schedule executor uses `O_EXCL` (create-or-fail) semantics when acquiring its PID file. Concurrent executor startups cannot both succeed. Stale PID files from crashed processes are detected and cleaned up automatically.

### SpawnOptions Interface

`AgentAdapter.spawn()` now accepts a single `SpawnOptions` object instead of 6 positional parameters. This is an internal refactor with no observable behaviour change.

### Extracted Pure Functions

All extracted functions are DI-injectable and have dedicated unit tests:
- `refetchAfterAgentEval(loop, taskId)` — stale-state guard in `LoopHandler`
- `handleStopDecision(loop, iteration, evalResult, status)` — stop-path logic in `LoopHandler`
- `buildEvalPromptBase(loop, taskId, loopRepo)` — shared eval prompt context
- `acquirePidFile(pidPath, pid)` — atomic PID file locking
- `checkActiveSchedules(scheduleRepo)` — schedule liveness check
- `registerSignalHandlers(cleanup, proc?)` — SIGTERM/SIGINT registration
- `startIdleCheckLoop(scheduleRepo, intervalMs, onIdle, warn)` — idle exit timer

---

## What's Changed Since v1.2.0

- **feat**: dashboard redesign — metrics view, workspace view, activity feed, cost tracking (#133)
- **feat**: live agent output streaming in workspace view (#133)
- **feat**: cost and token tracking for Claude agents (#133)
- **feat**: orchestrator_id propagation through CLI and MCP spawn paths (#133)
- **feat**: cancel cascade for orchestrations (#133)
- **feat**: responsive layout with terminal size detection (#133)
- **feat**: feedforward and judge evaluator modes (#136)
- **refactor**: extract refetchAfterAgentEval helper (#137)
- **refactor**: extract handleStopDecision helper (#138)
- **refactor**: SpawnOptions object replaces 6 positional spawn() params (#139)
- **refactor**: extract buildEvalPromptBase shared utility (#140)
- **fix**: atomic PID file locking with sentinel result (#141)
- **refactor**: extract schedule-executor pure functions with DI (#142)
- **refactor**: extract shared eval test fixtures (#143)
- **fix**: ActivityPanel Enter dispatch via activity focus mode (#133)
- **fix**: zombie orchestration recovery via worker liveness detection (#133)
- **fix**: orchestration creation failure compensating soft-delete (#133)

---

## Installation

```bash
npm install -g autobeat@1.3.0
```

Or use npx for MCP integration:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.3.0", "mcp", "start"]
    }
  }
}
```

---

## Links

- NPM Package: https://www.npmjs.com/package/autobeat
- Documentation: https://github.com/dean0x/autobeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/autobeat/issues

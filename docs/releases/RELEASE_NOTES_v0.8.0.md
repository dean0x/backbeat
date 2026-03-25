# Backbeat v0.8.0 — Loop Pause/Resume, Scheduled Loops & Git Integration

Enhanced loop lifecycle with pause/resume controls, cron-scheduled loop execution, git-aware loop iteration tracking, and CLI naming standardization.

---

## New Features

### Loop Pause/Resume (PR #115)

Pause active loops mid-iteration, resume from last checkpoint:

- **Pause**: Halts the loop after the current iteration completes. State persists across restart
- **Resume**: Continues from the last completed iteration with full checkpoint context
- **MCP Tools**: `PauseLoop`, `ResumeLoop`
- **CLI**: `beat loop pause <loop-id>`, `beat loop resume <loop-id>`

### Scheduled Loops (PR #115)

Compose loops with cron or one-time schedules:

- **Cron Scheduling**: Each cron trigger creates a new loop instance with its own iteration state
- **One-Time Scheduling**: Schedule a loop to start at a specific time
- **MCP Tool**: `ScheduleLoop`
- **CLI**: `beat schedule create --loop --until <cmd> --cron "..."`

### Git Integration (PR #115)

Optional git-aware loop iteration tracking:

- **`--git-branch`**: Creates a branch for the loop and tracks changes per iteration
- **Diff Tracking**: Diffs automatically tracked between iterations
- **Note**: v0.8.1 corrects the git integration design from branch-per-iteration to commit-per-iteration for correctness

---

## CLI Improvements (PR #117)

### Flag Renames

- `--direction minimize|maximize` → `--minimize` / `--maximize` boolean flags (mutual exclusion validated)
- `--continue-context` → `--checkpoint`

### Subcommand Renames

- `beat schedule get` → `beat schedule status`
- `beat loop get` → `beat loop status`

### MCP Tool Rename

- `GetSchedule` → `ScheduleStatus`

### Deprecated Hint

- `beat loop get` prints a rename hint directing users to `beat loop status`

---

## Refactoring

- **Discriminated Unions** (#114): Parser types converted to discriminated unions for exhaustive pattern matching
- **Pure Parser Extraction**: `parseScheduleCreateArgs` extracted as a pure, testable function
- **Schedule Parser Consistency**: Improved validation and error messages

---

## Breaking Changes

- **MCP Tool Rename**: `GetSchedule` → `ScheduleStatus`
- **CLI Flag Renames**: `--direction` → `--minimize`/`--maximize`, `--continue-context` → `--checkpoint`
- **CLI Subcommand Renames**: `get` → `status` (both `schedule` and `loop` commands)

---

## Database

- **Migration 11**: Adds `loop_pause_state` column for pause/resume persistence, `schedule_id` foreign key on loops table for scheduled loops, and git configuration storage columns.

---

## Events

2 new events (31 total):

- **LoopPaused**: Emitted when a loop is paused
- **LoopResumed**: Emitted when a paused loop is resumed

---

## Installation

```bash
npm install -g backbeat@0.8.0
```

Or use npx:
```json
{
  "mcpServers": {
    "backbeat": {
      "command": "npx",
      "args": ["-y", "backbeat", "mcp", "start"]
    }
  }
}
```

---

## Links

- NPM Package: https://www.npmjs.com/package/backbeat
- Documentation: https://github.com/dean0x/backbeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/backbeat/issues

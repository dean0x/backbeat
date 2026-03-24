# Backbeat v0.7.0 — Task/Pipeline Loops

Iterative task execution with retry and optimize strategies. Run a task (or full pipeline) in a loop until an exit condition is met, with configurable safety controls and score-based optimization.

---

## New Features

### Task Loops

Create loops that repeat a task until a shell-based exit condition passes:

- **Retry Strategy**: Run a task until a shell command returns exit code 0 (e.g., `npm test`)
- **Optimize Strategy**: Score each iteration with an eval script, keep the best result (minimize or maximize direction)
- **Exit Condition Evaluation**: Configurable eval timeout (default: 60s, minimum: 1s)
- **Fresh Context**: Each iteration gets a clean agent context by default, or continues from previous checkpoint

### Pipeline Loops

Repeat a multi-step pipeline (2-20 steps) per iteration instead of a single task:

- **Linear Dependencies**: Each pipeline step depends on the previous step within the iteration
- **Same Exit Condition**: Evaluated after all pipeline steps complete
- **Tail-Task Tracking**: Only the last pipeline task triggers iteration evaluation

### Safety Controls

- **Max Iterations**: Safety cap on iteration count (0 = unlimited, default: 10)
- **Max Consecutive Failures**: Stop after N consecutive failures (default: 3)
- **Cooldown**: Configurable delay between iterations in milliseconds (default: 0)

### MCP Tools

- **CreateLoop**: Create an iterative loop with retry or optimize strategy
- **LoopStatus**: Get loop details including optional iteration history
- **ListLoops**: List loops with optional status filter and pagination
- **CancelLoop**: Cancel an active loop, optionally cancelling in-flight iteration tasks

### CLI Commands

- `beat loop <prompt> --until <cmd>`: Create a retry loop
- `beat loop <prompt> --eval <cmd> --minimize|--maximize`: Create an optimize loop
- `beat loop --pipeline --step "..." --step "..." --until <cmd>`: Create a pipeline loop
- `beat loop list [--status <status>]`: List loops with optional status filter
- `beat loop status <loop-id> [--history]`: Get loop details and iteration history
- `beat loop cancel <loop-id> [--cancel-tasks] [reason]`: Cancel a loop

### Event System

4 new events (29 total):

- **LoopCreated**: Emitted when a new loop is created
- **LoopIterationCompleted**: Emitted when an iteration finishes with its result (pass/fail/keep/discard/crash)
- **LoopCompleted**: Emitted when the loop reaches its exit condition or max iterations
- **LoopCancelled**: Emitted when a loop is cancelled

---

## Breaking Changes

None. This release is fully additive.

---

## Database

- **Migration 10**: Adds `loops` table for loop definitions and state, and `loop_iterations` table for per-iteration execution records with scores, exit codes, and error messages.

---

## Installation

```bash
npm install -g backbeat@0.7.0
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

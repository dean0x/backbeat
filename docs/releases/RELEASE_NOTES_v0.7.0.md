# Backbeat v0.7.0 — SQLite Worker Coordination

Cross-process worker coordination via SQLite `workers` table, replacing in-memory-only tracking. Enables multi-process Backbeat deployments with PID-based crash detection and duplicate-spawn prevention.

---

## New Features

### Cross-Process Worker Coordination (PR #94)

Workers are now registered in SQLite with their owner PID. This enables:

- **Crash detection**: On startup, recovery checks if each worker's owner process is alive
- **Duplicate prevention**: `UNIQUE(taskId)` constraint prevents two processes from spawning workers for the same task
- **Stale cleanup**: Dead worker registrations are cleaned automatically during recovery

### PID-Based Recovery

Replaces the 30-minute staleness heuristic with definitive PID-based detection:

- If a worker's owner PID is alive → task is genuinely running, leave it alone
- If owner PID is dead → task definitively crashed, mark FAILED immediately
- No false positives from short tasks, no 30-minute wait for crashed tasks

---

## Breaking Changes

### RUNNING Tasks Marked FAILED on Upgrade

**Before (v0.6.x):** RUNNING tasks without a worker registration were left in RUNNING state or recovered via a staleness heuristic.

**After (v0.7.0+):** On first startup after upgrade, migration 9 creates an empty `workers` table. Any RUNNING tasks from v0.6.x have no corresponding worker row, so recovery marks them FAILED immediately (exit code -1).

**Mitigation:** Wait for all running tasks to complete before upgrading. If tasks are marked FAILED unexpectedly after upgrade, re-delegate them.

### Required Constructor Dependencies

`WorkerRepository` and `OutputRepository` are now required constructor parameters for `EventDrivenWorkerPool`. This affects custom integrations that instantiate the worker pool directly. MCP and CLI users are unaffected (bootstrap wires dependencies automatically).

---

## Database

- **Migration 9**: Adds `workers` table with columns `workerId`, `taskId` (UNIQUE), `pid`, `ownerPid`, `agent`, `startedAt`. Used for cross-process coordination and crash detection.

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

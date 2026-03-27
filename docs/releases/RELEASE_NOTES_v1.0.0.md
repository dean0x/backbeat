# Autobeat v1.0.0 -- Autonomous Coding Agent Orchestration

The v1.0.0 release marks the completion of Autobeat's original vision: give it a goal, walk away, come back to finished work. Orchestrator Mode is a meta-agent that uses Autobeat's own infrastructure -- task delegation, dependency ordering, eval loops, crash recovery -- to autonomously break down goals and drive them to completion.

```bash
beat orchestrate "Build a complete auth system with JWT, OAuth2, and MFA"
```

---

## Orchestrator Mode

The orchestrator is a loop that runs a lead agent with access to all of Autobeat's CLI commands. Each iteration, the agent:

1. Reads its persistent state file (plan, worker status, iteration history)
2. Breaks the goal into subtasks and delegates to worker agents via `beat run`
3. Uses task dependencies (`--depends-on`) to enforce execution ordering
4. Monitors worker progress with `beat status` and `beat logs`
5. Creates eval loops (`beat loop`) for tasks that need verification
6. Retries or adjusts failed workers with enriched context
7. Updates its state file and continues until the goal is met

### CLI Commands

- `beat orchestrate "<goal>"` -- Create and run an orchestration (detached by default)
- `beat orchestrate "<goal>" --foreground` -- Block and wait for completion (Ctrl+C to cancel)
- `beat orchestrate status <id>` -- Check orchestration status and plan progress
- `beat orchestrate list [--status <status>]` -- List orchestrations with optional status filter
- `beat orchestrate cancel <id> [reason]` -- Cancel an active orchestration

Options: `--agent`, `--working-directory`, `--max-depth` (1-10, default 3), `--max-workers` (1-20, default 5), `--max-iterations` (1-200, default 50)

### MCP Tools

- **CreateOrchestrator** -- Create and start an orchestration with goal, guardrails, and agent selection
- **OrchestratorStatus** -- Get orchestration details including plan steps and state
- **ListOrchestrators** -- List orchestrations with status filter and pagination
- **CancelOrchestrator** -- Cancel an active orchestration with optional reason

### State File

Each orchestration writes a persistent JSON state file to `~/.autobeat/orchestrator-state/`. The state file contains the plan, step statuses, iteration count, and arbitrary agent context. Atomic file writes (temp + rename) prevent corruption on crash.

### Guardrails

- **Max Depth** (1-10, default 3): Maximum delegation depth
- **Max Workers** (1-20, default 5): Maximum concurrent worker agents
- **Max Iterations** (1-200, default 50): Maximum orchestrator loop iterations
- **Goal Length**: 1-8,000 characters

### Crash Recovery

Orchestrations are persisted in SQLite. On startup, the recovery manager detects interrupted orchestrations and resumes them. The state file survives crashes and enables the agent to pick up exactly where it left off.

---

## What's Changed Since v0.8.2

### New Features
- Orchestrator Mode: autonomous goal execution with multi-agent delegation
- 4 new CLI commands (`beat orchestrate`, `status`, `list`, `cancel`)
- 4 new MCP tools (`CreateOrchestrator`, `OrchestratorStatus`, `ListOrchestrators`, `CancelOrchestrator`)
- Persistent state file with atomic I/O for crash resilience
- Configurable guardrails (depth, workers, iterations)
- Detach and foreground execution modes
- Multi-agent support: per-orchestration agent selection (Claude, Codex, Gemini)

### Refactoring
- `RecoveryManagerDeps` standardized: all handler deps follow consistent naming pattern
- `waitForLoopCompletion` extracted from CLI into reusable service function
- `handleOrchestrateForeground` extracted for testability

### Events
- 3 new events (34 total): `OrchestrationCreated`, `OrchestrationCompleted`, `OrchestrationCancelled`

### Database
- **Migration 14**: `orchestrations` table with status, guardrail columns, loop FK, and indexes

### Tests
- 88 new orchestration tests across 8 test files (state, CLI, repository, service, handler, prompt, integration)

### Documentation
- README overhauled for autonomous orchestration positioning
- ROADMAP updated for v1.0.0 release

### Stats
- 52 files changed, ~4,840 insertions, ~716 deletions (orchestrator mode PR)
- 6 additional documentation commits

---

## Semver Note

Despite the major version bump, all changes from v0.8.2 are **additive**. No existing APIs, CLI commands, or MCP tools were changed or removed. v1.0.0 marks a feature milestone -- the completion of autonomous orchestration -- not a breaking change boundary.

---

## Migration Notes

- **Database**: Migration 14 adds the `orchestrations` table. Auto-applied on startup. No user action needed.
- **State Directory**: `~/.autobeat/orchestrator-state/` created automatically on first orchestration.
- **Existing Workflows**: All existing `beat run`, `beat loop`, `beat schedule`, and `beat pipeline` commands work exactly as before.

---

## Installation

```bash
npm install -g autobeat@1.0.0
```

Or use npx:
```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat", "mcp", "start"]
    }
  }
}
```

---

## Links

- NPM Package: https://www.npmjs.com/package/autobeat
- Documentation: https://github.com/dean0x/autobeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/autobeat/issues

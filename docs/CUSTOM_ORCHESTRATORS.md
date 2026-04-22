# Custom Orchestrators

Build your own orchestration logic using Autobeat's low-level building blocks.

## Overview

`CreateOrchestrator` is a turnkey solution: it creates a state file, installs an
exit condition checker, builds a complete system prompt, and wires everything into
a retry loop for you. Custom orchestrators give you the same primitives without the
pre-built prompt — so you can define your own role, evaluation criteria, loop
structure, and termination logic.

**When to use custom orchestrators:**
- You need a specialist role (code reviewer, security auditor, debate moderator)
- You want multi-pass evaluation (score-and-rank rather than pass/fail)
- You need a non-standard termination condition
- You want to build on top of Autobeat's loops without adopting the built-in agent prompt

**When to use `CreateOrchestrator` instead:**
- Open-ended software engineering tasks
- Standard decompose → delegate → validate → complete workflow
- You don't have strong opinions about the agent's role or loop strategy

---

## Quick Start (CLI)

```bash
# 1. Initialize scaffolding
beat orchestrate init "Perform a multi-pass security audit of src/"

# Output:
#   State file:       ~/.autobeat/orchestrator-state/state-1745012345-a1b2c3d4.json
#   Exit condition:   node ~/.autobeat/orchestrator-state/check-complete-state-1745012345-a1b2c3d4.js
#
#   Ready-to-use loop command:
#
#     beat loop "<your orchestrator prompt>" \
#       --strategy retry \
#       --until "node ~/.autobeat/orchestrator-state/check-complete-state-1745012345-a1b2c3d4.js" \
#       --system-prompt "$(cat <<'PROMPT'
#     <delegation instructions>
#     <state management instructions>
#     <constraint instructions>
#     PROMPT
#     )"

# 2. Customize the prompt and run
beat loop "You are a security auditor. ..." \
  --strategy retry \
  --until "node ~/.autobeat/orchestrator-state/check-complete-state-<id>.js" \
  --system-prompt "<your custom system prompt>"
```

### Available flags for `beat orchestrate init`

| Flag | Default | Description |
|------|---------|-------------|
| `-w, --working-directory DIR` | cwd | Working directory for the subsequent loop command |
| `-a, --agent AGENT` | system default | Agent name threaded into delegation examples |
| `-m, --model MODEL` | agent default | Model threaded into delegation examples |
| `--max-workers N` | 5 | Max concurrent workers in constraint snippet |
| `--max-depth N` | 3 | Max delegation depth in constraint snippet |

---

## Quick Start (MCP)

```json
// Step 1: InitCustomOrchestrator
{
  "tool": "InitCustomOrchestrator",
  "goal": "Perform a multi-pass security audit of src/",
  "agent": "claude",
  "maxWorkers": 3,
  "maxDepth": 2
}

// Response:
{
  "success": true,
  "stateFilePath": "~/.autobeat/orchestrator-state/state-1745012345-a1b2c3d4.json",
  "exitConditionScript": "~/.autobeat/orchestrator-state/check-complete-state-1745012345-a1b2c3d4.js",
  "suggestedExitCondition": "node ~/.autobeat/orchestrator-state/check-complete-state-1745012345-a1b2c3d4.js",
  "instructions": {
    "delegation": "WORKER MANAGEMENT (via beat CLI):\n  ...",
    "stateManagement": "STATE FILE: ~/.autobeat/orchestrator-state/state-1745012345-a1b2c3d4.json\n  ...",
    "constraints": "CONSTRAINTS:\n- Max concurrent workers: 3\n  ..."
  },
  "usage": "CreateLoop with:\n  ..."
}

// Step 2: CreateLoop
{
  "tool": "CreateLoop",
  "prompt": "You are a security auditor. Analyze src/ for vulnerabilities ...",
  "strategy": "retry",
  "exitCondition": "node ~/.autobeat/orchestrator-state/check-complete-state-<id>.js",
  "systemPrompt": "<delegation instructions>\n\n<stateManagement instructions>\n\n<constraints instructions>",
  "agent": "claude",
  "maxIterations": 20
}
```

---

## Building Blocks

### State File

Each custom orchestration gets a dedicated state file at
`~/.autobeat/orchestrator-state/state-<timestamp>-<uuid>.json`.

The state file is the communication channel between the loop's exit condition and the
running agent. The agent reads and writes it each iteration; the exit script checks
`status === "complete"` to decide whether to stop.

**Initial state (written by scaffolding):**
```json
{
  "version": 1,
  "goal": "your goal here",
  "status": "planning",
  "plan": [],
  "context": {},
  "iterationCount": 0
}
```

**Agent's responsibility:** Update `status` to one of:
- `"planning"` → still decomposing
- `"executing"` → tasks in flight
- `"validating"` → checking results
- `"complete"` → goal achieved (exit condition passes)
- `"failed"` → unrecoverable error (loop terminates after a few more iterations)

**`context`** is a free-form object. Use it to store task IDs, intermediate results,
progress notes — anything the agent needs to persist across iterations.

### Exit Condition Script

The exit condition script reads the state file and exits 0 when `status === "complete"`,
non-zero otherwise. It is hardcoded to its state file at creation time so multiple
concurrent orchestrations never interfere.

```js
// Generated content — do not edit
try {
  const s = JSON.parse(require('fs').readFileSync('/path/to/state.json', 'utf8'));
  process.exit(s.status === 'complete' ? 0 : 1);
} catch { process.exit(1); }
```

Pass the script path as `--until` (CLI) or `exitCondition` (MCP) in your CreateLoop call.

### Delegation Instructions

The delegation snippet tells the agent how to use the `beat` CLI to spawn and monitor
workers. It covers:
- `beat run` / `beat status` / `beat logs` / `beat cancel`
- `beat loop` shell and agent eval modes
- Agent eval sub-strategies (feedforward, schema, judge)

If you passed `--agent` and/or `--model` to `init`, the snippet embeds the correct
flags so the agent automatically threads them to workers.

### State Management Instructions

The state management snippet covers:
- When and how to read the state file (start of each iteration)
- When and how to write the state file (before exiting each iteration)
- Completion signal (`status: "complete"`)
- Failure signal (`status: "failed"` with explanation in `context`)
- Resilience guidance (reconstructing state from active tasks if file is missing)

### Constraint Instructions

The constraint snippet sets numeric limits and qualitative guidance:
- Max concurrent workers
- Max delegation depth
- Sequential work preference for overlapping files
- Per-module worker cap (max 3)

---

## Examples

### Example 1: Code Review Orchestrator

```bash
# Initialize with tight worker limits (reviewers share the codebase)
beat orchestrate init "Review all PRs in the queue and post feedback" \
  --max-workers 2 --max-depth 1

# Build and run the loop
INIT_OUTPUT=$(beat orchestrate init "Review all PRs in the queue" --max-workers 2 --max-depth 1)
STATE_FILE=$(echo "$INIT_OUTPUT" | grep "State file:" | awk '{print $NF}')
EXIT_SCRIPT=$(echo "$INIT_OUTPUT" | grep "Exit condition:" | awk '{print $NF}')

beat loop \
  "You are a code reviewer. Your job is to review open PRs and post constructive feedback." \
  --strategy retry \
  --until "node $EXIT_SCRIPT" \
  --max-iterations 10
```

### Example 2: Database Migration Orchestrator (MCP)

```json
// Initialize
{ "tool": "InitCustomOrchestrator", "goal": "Run all pending migrations and verify DB state", "maxWorkers": 1, "maxDepth": 1 }

// Create loop with custom role
{
  "tool": "CreateLoop",
  "prompt": "You are a database migration orchestrator. Run `beat run 'apply next pending migration'`, verify it succeeded, and update the state file.",
  "strategy": "retry",
  "exitCondition": "node /path/to/check-complete-state-xxx.js",
  "systemPrompt": "<state management snippet>\n\n<delegation snippet>\n\n<constraints snippet>",
  "maxIterations": 50
}
```

### Example 3: Multi-Agent Debate (optimize strategy)

Use `--strategy optimize` when you want the agent to improve iteratively and score
itself rather than binary pass/fail:

```json
{
  "tool": "InitCustomOrchestrator",
  "goal": "Write the best possible README for this project",
  "maxWorkers": 3
}
// Then CreateLoop with:
// strategy: "optimize"
// evalMode: "agent"
// evalDirection: "maximize"
// evalPrompt: "Score this README from 0-100 based on clarity, completeness, and actionability."
```

---

## State File Reference

```typescript
interface OrchestratorStateFile {
  version: 1;                         // Always 1
  goal: string;                       // Original goal
  status: 'planning' | 'executing' | 'validating' | 'complete' | 'failed';
  plan: OrchestratorPlanStep[];       // Optional — for structured plans
  context: Record<string, unknown>;  // Free-form persistence across iterations
  iterationCount: number;             // Informational — incremented by the loop
}

interface OrchestratorPlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  taskId?: string;       // beat task ID if delegated
  dependsOn?: string[];  // Other step IDs
  failureCount?: number;
  lastError?: string;
}
```

---

## Cleanup

State files and exit scripts accumulate in `~/.autobeat/orchestrator-state/`. Each
file is small (~1KB) and safe to delete after the orchestration completes.

To clean up files older than 7 days:
```bash
find ~/.autobeat/orchestrator-state -mtime +7 -delete
```

---

## Comparison: CreateOrchestrator vs Custom Orchestrator

| Aspect | `CreateOrchestrator` | Custom Orchestrator |
|--------|----------------------|---------------------|
| Setup | One tool call | Two steps (init + loop) |
| System prompt | Auto-generated (full role + protocol) | You write it |
| Agent role | Software engineering orchestrator | Whatever you define |
| Termination | State file `status: complete` | Same |
| Loop strategy | Always retry | retry or optimize |
| Evaluation | Shell exit code (state file) | Shell or agent eval |
| Best for | Standard engineering tasks | Specialist workflows |

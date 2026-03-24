# Backbeat Development Roadmap

## Current Status: v0.7.0 ✅

**Status**: Released (2026-03-21)

Backbeat v0.7.0 adds task/pipeline loops — condition-driven iteration with retry and optimize strategies. See [FEATURES.md](./FEATURES.md) for complete list of current capabilities.

---

## Released Versions

### v0.4.0 - First Release as Backbeat ✅
**Status**: **RELEASED** to npm (2026-03-03)

Major features: task scheduling (cron/one-time), task resumption (checkpoints), session continuation (`continueFrom`), CLI detach mode, CLI UX overhaul (@clack/prompts), git/worktree removal, pagination, project rename (claudine → backbeat).

See [RELEASE_NOTES_v0.4.0.md](./releases/RELEASE_NOTES_v0.4.0.md) for full details.

### v0.3.0–v0.3.3 - Task Dependencies ✅
**Status**: **RELEASED**

DAG-based dependencies, cycle detection, TOCTOU protection, settling workers, graph corruption fix, pagination, configurable chain depth, DB constraints.

### v0.3.1 Optimization Items — Status

Items originally planned for v0.3.1 that were completed across v0.3.1–v0.4.0:

| Item | Status | Shipped In |
|------|--------|------------|
| Batch Dependency Resolution | ✅ Done | v0.3.1 |
| Multi-Dependency Transactions | ✅ Done | v0.3.1 (atomic `addDependencies()`) |
| Input Validation Limits (100 deps, 100 depth) | ✅ Done | v0.3.1 |
| Chain Depth Calculation (`getMaxDepth()`) | ✅ Done | v0.3.1 |
| Database CHECK Constraint (resolution column) | ✅ Done | v0.3.2 (migration v2) |
| Configurable Chain Depth Limit | ✅ Done | v0.3.2 |
| Handler Setup Extraction | ✅ Done | v0.4.0 (PR #42) |
| Pagination (`findAll()` default 100) | ✅ Done | v0.4.0 (PR #43) |
| Incremental Graph Updates | Open | — |
| Parallel Dependency Validation | Open | — |
| Transitive Query Memoization | Open | — |
| Remove Cycle Detection from Repository Layer | Open | — |
| Consolidate Graph Caching | Open | — |
| JSDoc Coverage for dependency APIs | Open | — |
| Failed/Cancelled Dependency Propagation Semantics | ✅ Done | v0.6.0 (cascade cancellation) |

Open items are low priority — they'll be addressed opportunistically or when performance demands it.

---

## Future Development

### v0.5.0 - Multi-Agent Support ✅
**Status**: **RELEASED** (2026-03-10)

Agent registry with pluggable adapters (Claude, Codex, Gemini), per-task agent selection, `beat init` interactive setup, `beat agents list`, default agent configuration, auth checking, and comprehensive test coverage (#54).

---

### v0.6.0 - Architectural Simplification + Bug Fixes ✅
**Status**: **RELEASED** (2026-03-20)
**Issue**: [#105](https://github.com/dean0x/backbeat/issues/105)

Architectural simplification (hybrid event model, SQLite worker coordination, ReadOnlyContext CLI), scheduled pipelines, bug fixes, and tech debt cleanup.

#### Features
- Scheduled pipelines — `SchedulePipeline` MCP tool, `--pipeline --step` CLI, dependency failure cascade, `cancelTasks` on `CancelSchedule` (#78)
- Simplify Event System — replace 18 overhead events with direct calls (#91)
- SQLite worker coordination + output persistence (#94)
- ReadOnlyContext for lightweight CLI query commands (#100)
- `runInTransaction` for atomic multi-step DB operations (#85)
- Neutralize Claude-specific branding for multi-provider positioning (#86)

#### Bug Fixes
- RecoveryManager dependency-aware crash recovery (#84)
- CancelSchedule scope: cancel tasks from ALL active executions (#82)
- Output totalSize recalculated after tail-slicing (#95)
- ScheduleExecutor FAIL policy atomicity (#83)

#### Tech Debt
- OutputRepository interface moved to core/interfaces.ts — DIP compliance (#101)
- BootstrapOptions boolean flags replaced with BootstrapMode enum (#104)

See [RELEASE_NOTES_v0.6.0.md](./releases/RELEASE_NOTES_v0.6.0.md) for full details.

---

### v0.7.0 - Task/Pipeline Loops ✅
**Status**: **RELEASED** (2026-03-21)
**Issue**: [#79](https://github.com/dean0x/backbeat/issues/79)

Condition-driven iteration — repeat a task or pipeline until an exit condition is met. The [Ralph Wiggum Loop](https://ghuntley.com/loop/) pattern.

#### Features
- Task/Pipeline Loops — `CreateLoop` MCP tool, `beat loop` CLI, retry and optimize strategies (#79)
- Retry strategy: shell command exit code 0 ends the loop
- Optimize strategy: eval script returns a score, loop seeks best (minimize or maximize)
- Pipeline loops: repeat a multi-step pipeline (2–20 steps) per iteration
- Fresh context per iteration (default) or continue from checkpoint
- Safety controls: max iterations, max consecutive failures, cooldown, eval timeout
- 4 MCP tools: `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`
- 4 CLI commands: `beat loop`, `beat loop list`, `beat loop status`, `beat loop cancel`
- 4 events: `LoopCreated`, `LoopIterationCompleted`, `LoopCompleted`, `LoopCancelled`

#### Builds On
- v0.4.0 schedules (cron/one-time), checkpoints, `continueFrom`
- v0.4.1 pipelines (`CreatePipeline`)
- v0.5.0 multi-agent per-task selection
- v0.6.0 architectural simplification + scheduled pipelines

---

### v0.8.0 - Loop Enhancements
**Goal**: Loop lifecycle control, schedule composition, and git-aware iterations
**Priority**: High — completes the loop story started in v0.7.0

#### Features
- **Loop + Schedule Composition**: "Every night, loop until spec is done" — composable loops with cron/one-time schedules. A schedule trigger creates a loop instance per execution.
- **Loop Pause/Resume**: Pause an active loop mid-iteration and resume it later. Paused loops retain iteration state and checkpoint.
- **Git Integration for Loops**: Loop-aware git state management — branch per iteration, diff tracking between iterations, automatic branch cleanup on loop completion.

#### CLI
```bash
# Schedule a loop
beat schedule create --cron "0 9 * * *" --loop \
  --prompt "implement next item from spec.md" \
  --exit-condition "./check-spec-complete.sh" \
  --max-iterations 10

# Pause/resume
beat loop pause <loop-id>
beat loop resume <loop-id>

# Git integration
beat loop create "refactor auth module" \
  --exit-condition "./tests-pass.sh" \
  --git-branch-per-iteration \
  --base-branch main
```

#### MCP Tools
- `ScheduleLoop` — create a scheduled loop (cron/one-time trigger → loop)
- `PauseLoop` / `ResumeLoop` — lifecycle control
- `CreateLoop` updated — optional `gitConfig` parameter for branch-per-iteration

#### Builds On
- v0.4.0 scheduling (cron/one-time), checkpoints
- v0.6.0 scheduled pipelines pattern
- v0.7.0 task/pipeline loops

---

### v0.9.0 - Agent Failover & Smart Routing
**Goal**: Automatic agent switching on rate limits, intelligent task routing
**Priority**: High — makes multi-agent practically useful

#### Features
- **Rate Limit Detection**: Per-agent signal parsing (stderr patterns, exit codes, API errors)
- **Automatic Failover**: When an agent hits limits mid-task, checkpoint and resume with a different agent
- **Failover Priority Chain**: User-defined agent preference order (e.g., claude → codex → gemini)
- **Smart Routing**: Route tasks based on complexity, cost, or agent strengths
- **Usage Tracking**: Track per-agent usage to predict limit exhaustion
- **Cooldown Management**: Track rate limit windows, re-enable agents when limits reset

#### Builds On
- v0.4.0 checkpoint/resumption system (`continueFrom`)
- v0.5.0 agent registry and adapters
- v0.7.0 task/pipeline loops

---

### v0.10.0 - Workflow Recipes & Templates
**Goal**: Reusable multi-step workflows with predefined DAGs
**Priority**: Medium — power user productivity
**Note**: Renumbered from v0.9.0

#### Features
- **Recipe Definitions**: YAML/JSON workflow specifications
- **Recipe Registry**: Built-in and user-defined recipes
- **Variable Substitution**: Parameterize recipes with runtime values
- **Conditional Logic**: If/else branches based on task results
- **Recipe CLI**: `beat recipe run <name>` for one-command workflows
- **Recipe Sharing**: Export/import recipes between projects

#### Example Recipe
```yaml
name: pr-review
description: "Lint, test, review, and summarize a PR"
variables:
  branch: { required: true }
tasks:
  - name: lint
    prompt: "Run linter on {{branch}} and fix issues"
    agent: claude

  - name: test
    prompt: "Run test suite, fix failures"
    agent: claude
    dependsOn: [lint]

  - name: review
    prompt: "Review changes on {{branch}} for security and quality"
    agent: claude
    dependsOn: [test]
    continueFrom: test

  - name: summarize
    prompt: "Write a PR summary based on review findings"
    agent: claude
    dependsOn: [review]
    continueFrom: review
```

#### CLI
```bash
beat recipe list
beat recipe run pr-review --branch feature/auth
beat recipe run refactor --target src/services/
beat recipe create my-workflow  # interactive recipe builder
```

#### Builds On
- v0.4.0 task dependencies (DAG), scheduling, `continueFrom`
- v0.5.0 per-task agent selection
- v0.7.0 task/pipeline loops, loops

---

### v0.11.0 - Monitoring & REST API
**Goal**: Production observability and external integrations
**Priority**: Medium — production readiness

#### Features
- **TUI Dashboard**: Terminal UI showing running tasks, agents, output streams, resource usage
- **REST API**: HTTP API alongside MCP for non-MCP clients (OpenAPI spec)
- **Metrics**: Task completion rates, execution times, agent usage, failover frequency
- **Notifications**: Slack/email/webhook alerts on task completion or failure
- **Audit Logging**: Complete audit trail for all operations
- **Multi-User Support**: User authentication and task isolation

---

### v1.0.0 - Distributed Processing
**Goal**: Scale across multiple servers for enterprise deployments
**Priority**: Low — when there's actual demand

#### Features
- **Multi-Server Support**: Distribute tasks across Backbeat instances
- **Shared State**: Centralized task queue (Redis backend)
- **Fault Tolerance**: Automatic failover on server failures
- **Server Discovery**: Registration and health checks
- **Task Affinity**: Route related tasks to the same server

---

## Research & Experimentation

### Future Investigations
- **Smart Task Splitting**: Break large tasks into smaller parallel units
- **Result Aggregation**: Fan-out same task to multiple agents, compare results
- **Resource Prediction**: Predict agent resource needs based on prompt analysis
- **Auto-Recovery**: Intelligent retry strategies based on failure classification
- **Mid-Task Checkpoints**: Capture checkpoints during execution, not just at terminal states

### Community Requests
- **Windows Support**: Better Windows compatibility and testing
- **Docker Integration**: Containerized task execution
- **Plugin System**: Custom task executors and integrations

---

## Version Timeline

| Version | Status | Focus |
|---------|--------|-------|
| v0.2.0 | ✅ Released | Autoscaling + Persistence |
| v0.2.1 | ✅ Released | Event-driven Architecture |
| v0.3.0 | ✅ Released | Task Dependencies (DAG) |
| v0.3.1–3 | ✅ Released | Dependency optimizations + security |
| v0.4.0 | ✅ Released | Scheduling, Resumption, Rename to Backbeat |
| v0.5.0 | ✅ Released | Multi-Agent Support |
| v0.6.0 | ✅ Released | Architectural Simplification + Bug Fixes |
| v0.7.0 | ✅ Released | Task/Pipeline Loops |
| v0.8.0 | 📋 Planned | Loop Enhancements |
| v0.9.0 | 📋 Planned | Agent Failover + Smart Routing |
| v0.10.0 | 📋 Planned | Workflow Recipes & Templates |
| v0.11.0 | 💭 Research | Monitoring + REST API + Dashboard |
| v1.0.0 | 💭 Research | Distributed Processing |

---

## Contributing to the Roadmap

### How to Request Features
1. **Create Issue**: Use GitHub issues with feature request template
2. **Community Discussion**: Discuss in GitHub Discussions
3. **Use Cases**: Provide concrete examples of how you'd use the feature

For questions about the roadmap, please open a [GitHub Discussion](https://github.com/dean0x/backbeat/discussions).

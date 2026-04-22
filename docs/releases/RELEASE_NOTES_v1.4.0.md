# Autobeat v1.4.0 — System Prompts & Custom Orchestrators

Two additive features that extend the orchestration workflow: per-task system prompt injection across all three agent adapters, and scaffolding tools for building custom orchestrators from scratch. Plus expanded agent configuration documentation in the README.

---

## Highlights

- **System prompt support**: Inject custom instructions into any agent via `--system-prompt` on CLI or `systemPrompt` on MCP tools — wired through Claude, Codex, and Gemini adapters
- **Custom orchestrator scaffolding**: `beat orchestrate init` CLI and `InitCustomOrchestrator` MCP tool generate state files, exit condition scripts, and system prompt snippets
- **Agent configuration docs**: New README section covering API keys, base URLs, model selection, and local LLM usage

---

## System Prompt Support

Pass a system prompt to any task, loop, or orchestrator. The prompt is injected per-agent:

| Agent | Mechanism |
|-------|-----------|
| Claude | `--append-system-prompt` flag |
| Codex | `-c developer_instructions` flag |
| Gemini | `GEMINI_SYSTEM_MD` environment variable |

### CLI

```bash
# Single task
beat run "Refactor auth module" --system-prompt "Use dependency injection, no globals"

# Loop
beat loop "Optimize bundle size" --until "size < 100kb" \
  --system-prompt "Focus on tree-shaking and code splitting"

# Orchestrator
beat orchestrate "Build auth system" \
  --system-prompt "Use JWT for tokens, bcrypt for hashing"
```

### MCP Tools

```json
{
  "tool": "DelegateTask",
  "arguments": {
    "prompt": "Refactor auth module",
    "systemPrompt": "Use dependency injection, no globals"
  }
}
```

System prompts are supported on: `DelegateTask`, `CreateLoop`, `CreateOrchestrator`, `ScheduleTask`, `SchedulePipeline`, `ScheduleLoop`.

The `TaskStatus` tool accepts `includeSystemPrompt: true` to return the stored system prompt.

---

## Custom Orchestrator Scaffolding

Build custom orchestrators from scratch with generated scaffolding artifacts.

### CLI

```bash
beat orchestrate init "Build a microservices API gateway"
```

Generates:
- **State file** (`autobeat-orchestrator-state-<id>.json`) — persistent orchestration state with plan, steps, and iteration history
- **Exit condition script** (`autobeat-exit-condition-<id>.sh`) — shell script template for evaluating orchestration completion
- **System prompt snippets** — ready-to-copy instructions for delegation, state management, and constraint enforcement

### MCP Tool

```json
{
  "tool": "InitCustomOrchestrator",
  "arguments": {
    "goal": "Build a microservices API gateway",
    "workingDirectory": "/path/to/project"
  }
}
```

See [Custom Orchestrators Guide](../../docs/CUSTOM_ORCHESTRATORS.md) for full documentation.

---

## Agent Configuration Documentation

New README section documenting:
- API key setup for Claude, Codex, and Gemini
- Custom base URLs for proxies and local deployments
- Model selection via `--model` flag and `~/.autobeat/config.json`
- Local LLM usage with compatible API endpoints

---

## Database

- **Migration v23**: Adds `system_prompt TEXT` column to `tasks` table (nullable, auto-applied on startup)

---

## What's Changed Since v1.3.1

- System prompt support for tasks, loops, and orchestrators (#134, #147)
- Custom orchestrator scaffolding — `beat orchestrate init` CLI + `InitCustomOrchestrator` MCP tool (#135, #148)
- Agent configuration section added to README (#150)

---

## Migration Notes

- **Migration v23** is auto-applied on first startup — no user action required
- The `system_prompt` column is nullable; existing tasks are unaffected
- No breaking changes to CLI, MCP tools, or configuration

---

## Installation

```bash
npm install -g autobeat@1.4.0
```

Or via npx in your MCP config:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.4.0", "mcp", "start"]
    }
  }
}
```

---

## Links

- [npm](https://www.npmjs.com/package/autobeat)
- [Documentation](https://github.com/dean0x/autobeat)
- [Issues](https://github.com/dean0x/autobeat/issues)

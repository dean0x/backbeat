# Autobeat v0.5.0 — Multi-Agent Support

Autobeat is no longer Claude-only. v0.5.0 adds a pluggable agent registry with adapters for Claude, OpenAI Codex, and Google Gemini — with per-task agent selection across MCP, CLI, and interactive setup.

---

## New Features

### Multi-Agent Support (PR #72)

Delegate tasks to different AI agents — Claude, Codex, or Gemini — from a single Autobeat instance.

**Key Capabilities:**
- **Agent Registry**: Pluggable registry with adapter pattern for agent lifecycle management
- **Built-in Adapters**: Claude (`claude`), OpenAI Codex (`codex`), Google Gemini (`gemini-cli`)
- **Per-Task Agent Selection**: Choose which agent runs each task
- **Default Agent Config**: Set a system-wide default agent via `beat init` or config
- **Auth Checking**: Verify agent CLI tools are installed and authenticated before delegation

**MCP Usage:**
```typescript
await DelegateTask({
  prompt: "Implement the login page",
  agent: "codex"
});
```

**CLI Usage:**
```bash
beat run "implement the login page" --agent codex
```

### `beat init` — Interactive Setup (PR #75)

First-time setup wizard for configuring Autobeat defaults.

```bash
beat init              # Interactive — prompts for default agent
beat init --agent codex  # Non-interactive — set default agent directly
```

- Creates `~/.autobeat/config.json` with default agent selection
- Validates agent availability before saving

### `beat agents list` — Agent Discovery (PR #72)

Show all registered agents with their status.

```bash
beat agents list
```

- Displays agent name, type, default marker, and auth status
- Shows which agent is currently set as default

---

## Bug Fixes

- **git-state dirty file parsing** (PR #77): `.trim()` on full stdout was truncating the first porcelain filename; fixed to trim per-line

---

## Test Coverage

- **Handler unit tests** (PR #76): 21 new tests for PersistenceHandler, QueueHandler, and OutputHandler using real DB + repos (not mocks)
- **Final coverage gaps** (PR #77): 33 new tests across validation, output-repository, process-connector, and git-state
- **Stale test cleanup** (PR #76): Removed 3 `it.skip` tests for unimplemented threshold events
- **Total**: 900+ tests passing across all groups

---

## Installation

```bash
npm install -g autobeat@0.5.0
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

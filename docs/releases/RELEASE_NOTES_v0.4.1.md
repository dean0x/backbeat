# Backbeat v0.4.1 — CreatePipeline MCP Tool

Closes the last functional gap between CLI and MCP: pipeline creation is now available as an MCP tool.

---

## New Feature

### CreatePipeline MCP Tool

Create sequential task pipelines directly from MCP — no CLI required.

**Key Capabilities:**
- **2–20 steps** per pipeline with prompt and delay between steps
- **Per-step overrides**: priority and working directory per step
- **Shared service**: MCP and CLI both use `ScheduleManagerService.createPipeline()` — one code path, identical behavior

**MCP Usage:**
```typescript
await CreatePipeline({
  steps: [
    { prompt: "set up DB", delayMinutes: 0 },
    { prompt: "run migrations", delayMinutes: 5 },
    { prompt: "seed data", delayMinutes: 10, priority: 0 }
  ],
  workingDirectory: "/path/to/project"
});
```

**Equivalent CLI:**
```bash
beat pipeline "set up DB" --delay 5m "run migrations" --delay 10m "seed data"
```

### Pipeline Service Extraction

Pipeline creation logic extracted from the CLI `beat pipeline` command into `ScheduleManagerService.createPipeline()`. The CLI was refactored from an inline schedule loop (68 lines) to a single service call (42 lines). Both MCP and CLI now share the same business logic path.

---

## Test Coverage

- **17 new tests**: 11 service tests + 6 adapter tests
- Covers: pipeline bounds (2–20 steps), schedule chaining, priority/workDir inheritance, prompt truncation, and failure propagation
- **Total**: 860+ tests passing across all groups

---

## Installation

```bash
npm install -g backbeat@0.4.1
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

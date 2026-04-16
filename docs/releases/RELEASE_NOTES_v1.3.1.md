# Autobeat v1.3.1 — Preflight Script Hardening

Patch release fixing two issues in the release preflight script identified during code review.

---

## Fixes

### npm Registry Offline Handling

Previously, `npm view autobeat version` failures (network offline, registry timeout) were silently caught and defaulted to `0.0.0`, which would always pass the version-bump check — even if the version hadn't actually been bumped.

Now: the script warns that it couldn't reach the registry and skips the published-version comparison entirely, rather than making a false assumption.

### Remote Branch Sync Check

The preflight script now verifies that the local branch is in sync with its remote tracking branch before proceeding. This catches cases where `main` has new commits that haven't been pulled, preventing releases from stale local state.

---

## What's Changed Since v1.3.0

- Fixed silent npm offline pass in preflight script (#145)
- Added remote sync verification to preflight script (#145)

---

## Migration Notes

No migration required. This is a tooling-only patch — no changes to source code, database, or runtime behavior.

---

## Installation

```bash
npm install -g autobeat@1.3.1
```

Or via npx in your MCP config:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.3.1", "mcp", "start"]
    }
  }
}
```

---

## Links

- [npm](https://www.npmjs.com/package/autobeat)
- [Documentation](https://github.com/dean0x/autobeat)
- [Issues](https://github.com/dean0x/autobeat/issues)

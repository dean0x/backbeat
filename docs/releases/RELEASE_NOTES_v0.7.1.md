# Autobeat v0.7.1 — Dependency Fix

Fixes a missing dependency that caused `beat help` (and all CLI commands using colored output) to crash when installed globally via npm.

---

## Bug Fixes

- **Missing `picocolors` dependency**: `picocolors` was imported in `cli/commands/help.ts` and `cli/ui.ts` but not declared in `package.json`. It resolved locally via transitive dependency from `@clack/prompts`, but failed on global installs where npm doesn't guarantee hoisting of transitive dependencies.

---

## Installation

```bash
npm install -g autobeat@0.7.1
```

---

## Links

- NPM Package: https://www.npmjs.com/package/autobeat
- Documentation: https://github.com/dean0x/autobeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/autobeat/issues

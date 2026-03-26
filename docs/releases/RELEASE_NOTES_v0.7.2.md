# Autobeat v0.7.2 — Dependency Update

Updates `better-sqlite3` to the latest version (12.6.2 → 12.8.0).

---

## Changes

- **Updated `better-sqlite3`** from 12.6.2 to 12.8.0 — stay current with upstream fixes and improvements
- **Fixed flaky CI test**: Widened tolerance bounds on packet loss simulation test (`network-failures.test.ts`) — was asserting `0.2-0.4` range for a 30% random rate over 100 samples, which occasionally exceeded bounds in CI

---

## Installation

```bash
npm install -g autobeat@0.7.2
```

---

## Links

- NPM Package: https://www.npmjs.com/package/autobeat
- Documentation: https://github.com/dean0x/autobeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/autobeat/issues

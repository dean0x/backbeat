# Backbeat v0.8.1 — Commit-per-Iteration Git Integration

Corrects the git integration design from branch-per-iteration to commit-per-iteration. One branch for the entire loop, one commit per successful iteration, with full revert on failure/discard.

---

## Bug Fixes

### Git Integration Rewrite

The v0.8.0 branch-per-iteration strategy was replaced with a correct commit-per-iteration design:

- **One branch per loop**: A single branch is created for the entire loop lifecycle
- **One commit per iteration**: Each successful iteration (keep/pass) produces a commit on the loop branch
- **Full revert on failure**: Failed or discarded iterations are reset — retry loops revert to `gitStartCommitSha` (clean slate), optimize loops revert to the best iteration's commit (or `gitStartCommitSha` if no best iteration exists)
- **SHA tracking**: `gitStartCommitSha` on the loop, `gitCommitSha` and `preIterationCommitSha` on each iteration

---

## Refactoring

### Domain Model Updates

- **Loop**: Added `gitStartCommitSha` field to record the commit SHA at loop creation
- **LoopIteration**: Added `gitCommitSha` (commit created by this iteration) and `preIterationCommitSha` (commit to revert to on failure)
- **Legacy fields**: `gitBranch` on LoopIteration retained for migration safety but always null for v0.8.1+

### Git Utilities

New git helper functions for commit-based iteration tracking:

- `getCurrentCommitSha()` — reads current HEAD SHA
- `commitAllChanges()` — stages and commits all changes with a message
- `resetToCommit()` — hard-resets to a specific SHA with validation

### Loop Handler Rewrite

The loop handler git integration logic was rewritten to use the commit-per-iteration model, replacing all branch creation/switching with commit/reset operations.

---

## Database

- **Migration 12**: Adds `git_start_commit_sha` column to `loops` table, `git_commit_sha` and `pre_iteration_commit_sha` columns to `loop_iterations` table

---

## Installation

```bash
npm install -g backbeat@0.8.1
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

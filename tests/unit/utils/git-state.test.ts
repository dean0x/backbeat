/**
 * Unit tests for git state capture utility
 *
 * ARCHITECTURE: Tests captureGitState with mocked execFile
 * Pattern: vi.mock('child_process') to control git command responses
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Must import after mock setup
import { execFile } from 'child_process';
import {
  captureGitDiff,
  captureGitState,
  createAndCheckoutBranch,
  validateGitRefName,
} from '../../../src/utils/git-state.js';

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function mockExecFileSequence(responses: Array<{ stdout: string } | { error: Error }>): void {
  const mock = vi.mocked(execFile);
  let callIndex = 0;

  mock.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, callback?: unknown) => {
    // promisify wraps execFile — the callback is the last argument
    const cb = (callback ?? _opts) as ExecFileCallback;
    const response = responses[callIndex++];

    if ('error' in response) {
      cb(response.error, { stdout: '', stderr: '' });
    } else {
      cb(null, { stdout: response.stdout, stderr: '' });
    }

    return undefined as never;
  });
}

describe('captureGitState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return branch, commitSha, and dirtyFiles for a clean repo', async () => {
    mockExecFileSequence([
      { stdout: 'main\n' }, // rev-parse --abbrev-ref HEAD
      { stdout: 'abc123def456\n' }, // rev-parse HEAD
      { stdout: '' }, // git status --porcelain (clean)
    ]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      branch: 'main',
      commitSha: 'abc123def456',
      dirtyFiles: [],
    });
  });

  it('should return ok(null) when not a git repo', async () => {
    mockExecFileSequence([{ error: new Error('fatal: not a git repository') }]);

    const result = await captureGitState('/tmp/not-a-repo');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('should return ok(null) when HEAD does not exist (empty repo)', async () => {
    mockExecFileSequence([
      { stdout: 'HEAD\n' }, // rev-parse --abbrev-ref HEAD succeeds
      { error: new Error('fatal: ambiguous argument HEAD') }, // rev-parse HEAD fails
    ]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('should correctly parse dirty files from git status', async () => {
    mockExecFileSequence([
      { stdout: 'feature-branch\n' },
      { stdout: 'deadbeef\n' },
      { stdout: ' M src/foo.ts\n?? new-file.txt\nAM staged.ts\n' },
    ]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.branch).toBe('feature-branch');
    expect(result.value!.dirtyFiles).toEqual(['src/foo.ts', 'new-file.txt', 'staged.ts']);
  });

  it('should preserve filenames when first porcelain line has leading-space status', async () => {
    mockExecFileSequence([{ stdout: 'main\n' }, { stdout: 'abc123\n' }, { stdout: ' M src/only-modified.ts\n' }]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.dirtyFiles).toEqual(['src/only-modified.ts']);
  });

  it('should return empty dirtyFiles when status command fails', async () => {
    mockExecFileSequence([{ stdout: 'main\n' }, { stdout: 'abc123\n' }, { error: new Error('git status failed') }]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.dirtyFiles).toEqual([]);
  });
});

describe('createAndCheckoutBranch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should succeed when git checkout -B succeeds', async () => {
    mockExecFileSequence([{ stdout: '' }]); // git checkout -B succeeds

    const result = await createAndCheckoutBranch('/workspace', 'feat/loop-iter-1');
    expect(result.ok).toBe(true);
  });

  it('should succeed with fromRef argument', async () => {
    mockExecFileSequence([{ stdout: '' }]);

    const result = await createAndCheckoutBranch('/workspace', 'feat/loop-iter-2', 'main');
    expect(result.ok).toBe(true);
  });

  it('should return error when git checkout fails', async () => {
    mockExecFileSequence([{ error: new Error('fatal: not a git repository') }]);

    const result = await createAndCheckoutBranch('/tmp/not-a-repo', 'feat/branch');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to create/checkout branch');
  });

  it('should force-create over existing branch (git checkout -B behavior)', async () => {
    // -B flag resets existing branch — always succeeds
    mockExecFileSequence([{ stdout: '' }]);

    const result = await createAndCheckoutBranch('/workspace', 'existing-branch', 'main');
    expect(result.ok).toBe(true);
  });
});

describe('captureGitDiff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return diff summary between two branches', async () => {
    const diffOutput = ' src/main.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)';
    mockExecFileSequence([{ stdout: diffOutput + '\n' }]);

    const result = await captureGitDiff('/workspace', 'main', 'feat/loop-iter-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('src/main.ts');
    expect(result.value).toContain('5 +++--');
  });

  it('should return null when there are no changes', async () => {
    mockExecFileSequence([{ stdout: '\n' }]);

    const result = await captureGitDiff('/workspace', 'main', 'main');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('should return error when git diff fails', async () => {
    mockExecFileSequence([{ error: new Error('fatal: bad revision') }]);

    const result = await captureGitDiff('/workspace', 'main', 'nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to capture git diff');
  });
});

describe('validateGitRefName — git-check-ref-format rules', () => {
  it('should reject @{ pattern', () => {
    const result = validateGitRefName('feature@{0}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('@{');
  });

  it('should reject trailing dot', () => {
    const result = validateGitRefName('branch.');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'.'");
  });

  it('should reject trailing .lock suffix', () => {
    const result = validateGitRefName('branch.lock');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('.lock');
  });

  it('should reject glob characters ?, *, [', () => {
    for (const name of ['feature-*', 'feature-?', 'feature-[0]']) {
      const result = validateGitRefName(name);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('glob');
    }
  });

  it('should reject consecutive slashes //', () => {
    const result = validateGitRefName('refs//heads');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('consecutive slashes');
  });

  it('should reject dot-prefixed path component', () => {
    const result = validateGitRefName('.hidden/branch');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'.'");

    const result2 = validateGitRefName('refs/.config');
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.error.message).toContain("'.'");
  });

  it('should accept valid names with slashes (regression guard)', () => {
    const result = validateGitRefName('feature/iteration-1');
    expect(result.ok).toBe(true);
  });

  it('should accept valid names with mid-component dots (regression guard)', () => {
    const result = validateGitRefName('v1.0.0');
    expect(result.ok).toBe(true);
  });
});

describe('git exec timeout protection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include timeout option in captureGitState exec calls', async () => {
    const mock = vi.mocked(execFile);
    mock.mockClear();
    mockExecFileSequence([{ stdout: 'main\n' }, { stdout: 'abc123\n' }, { stdout: '' }]);

    await captureGitState('/workspace');

    // All 3 calls should include timeout in options
    expect(mock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const callArgs = mock.mock.calls[i];
      // Options object is the 3rd argument (index 2)
      const opts = callArgs[2] as Record<string, unknown>;
      expect(opts).toHaveProperty('timeout');
      expect(opts.timeout).toBeGreaterThan(0);
    }
  });

  it('should include timeout option in createAndCheckoutBranch exec calls', async () => {
    const mock = vi.mocked(execFile);
    mock.mockClear();
    mockExecFileSequence([{ stdout: '' }]);

    await createAndCheckoutBranch('/workspace', 'feat/branch');

    expect(mock).toHaveBeenCalledTimes(1);
    const opts = mock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toHaveProperty('timeout');
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('should include timeout option in captureGitDiff exec calls', async () => {
    const mock = vi.mocked(execFile);
    mock.mockClear();
    mockExecFileSequence([{ stdout: 'diff output\n' }]);

    await captureGitDiff('/workspace', 'main', 'feature');

    expect(mock).toHaveBeenCalledTimes(1);
    const opts = mock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toHaveProperty('timeout');
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('should propagate timeout errors from createAndCheckoutBranch as err()', async () => {
    const killedError = Object.assign(new Error('Command timed out'), { killed: true });
    mockExecFileSequence([{ error: killedError }]);

    const result = await createAndCheckoutBranch('/workspace', 'feat/branch');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to create/checkout branch');
  });

  it('should propagate timeout errors from captureGitDiff as err()', async () => {
    const killedError = Object.assign(new Error('Command timed out'), { killed: true });
    mockExecFileSequence([{ error: killedError }]);

    const result = await captureGitDiff('/workspace', 'main', 'feature');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to capture git diff');
  });

  it('should propagate timeout errors from captureGitState as err(), not ok(null)', async () => {
    // Simulate a killed process (timeout) on the first git call (branch check)
    const killedError = Object.assign(new Error('Command timed out'), { killed: true });
    mockExecFileSequence([{ error: killedError }]);

    const result = await captureGitState('/workspace');

    // Should be err(), NOT ok(null) — timeout is a real error, not "not a git repo"
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to capture git state');
  });

  it('should propagate timeout errors from second inner catch (SHA) as err()', async () => {
    const killedError = Object.assign(new Error('Command timed out'), { killed: true });
    mockExecFileSequence([
      { stdout: 'main\n' }, // Branch succeeds
      { error: killedError }, // SHA times out
    ]);

    const result = await captureGitState('/workspace');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to capture git state');
  });

  it('should propagate timeout errors from third inner catch (status) as err()', async () => {
    const killedError = Object.assign(new Error('Command timed out'), { killed: true });
    mockExecFileSequence([
      { stdout: 'main\n' }, // Branch succeeds
      { stdout: 'abc123\n' }, // SHA succeeds
      { error: killedError }, // Status times out
    ]);

    const result = await captureGitState('/workspace');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Failed to capture git state');
  });
});

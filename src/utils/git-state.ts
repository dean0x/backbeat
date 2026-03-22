/**
 * Git state capture and branch management utilities
 * ARCHITECTURE: Pure functions returning Result, uses execFile for security (no shell injection)
 * Pattern: All git operations use execFile (not exec) to prevent shell injection
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { err, ok, Result } from '../core/result.js';

const execFileAsync = promisify(execFile);

export interface GitState {
  readonly branch: string;
  readonly commitSha: string;
  readonly dirtyFiles: readonly string[];
}

/**
 * Capture current git state for a working directory
 * Returns null if the directory is not a git repository (not an error)
 * Uses execFile (not exec) to prevent shell injection
 *
 * @param workingDirectory - Absolute path to the working directory
 * @returns GitState if in a git repo, null if not, or error on unexpected failure
 */
export async function captureGitState(workingDirectory: string): Promise<Result<GitState | null>> {
  try {
    const execOpts = { cwd: workingDirectory };

    // Check if this is a git directory by getting the branch
    let branch: string;
    try {
      const branchResult = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts);
      branch = branchResult.stdout.trim();
    } catch {
      // Not a git directory or git not available - not an error
      return ok(null);
    }

    // Get commit SHA
    let commitSha: string;
    try {
      const shaResult = await execFileAsync('git', ['rev-parse', 'HEAD'], execOpts);
      commitSha = shaResult.stdout.trim();
    } catch {
      // HEAD might not exist (empty repo) - not an error
      return ok(null);
    }

    // Get dirty files from git status
    let dirtyFiles: readonly string[] = [];
    try {
      const statusResult = await execFileAsync('git', ['status', '--porcelain'], execOpts);
      if (statusResult.stdout.trim()) {
        dirtyFiles = statusResult.stdout
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => line.substring(3).trim()); // Remove status prefix (e.g., " M ", "?? ")
      }
    } catch {
      // Status failed - continue with empty dirty files
      dirtyFiles = [];
    }

    return ok({ branch, commitSha, dirtyFiles });
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to capture git state: ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory },
      ),
    );
  }
}

/**
 * Create and checkout a git branch
 * Uses `git checkout -B` (force create/reset) for crash recovery safety —
 * if the branch already exists from a prior crashed iteration, it is reset
 * rather than failing.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param branchName - Name of the branch to create/checkout
 * @param fromRef - Optional ref to branch from (e.g., 'main'). If omitted, branches from current HEAD.
 * @returns Result<void> on success, error on failure
 */
export async function createAndCheckoutBranch(
  workingDirectory: string,
  branchName: string,
  fromRef?: string,
): Promise<Result<void, BackbeatError>> {
  try {
    const args = ['checkout', '-B', branchName];
    if (fromRef) {
      args.push(fromRef);
    }

    await execFileAsync('git', args, { cwd: workingDirectory });
    return ok(undefined);
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create/checkout branch '${branchName}': ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory, branchName, fromRef },
      ),
    );
  }
}

/**
 * Capture git diff summary between two branches
 * Returns the `git diff --stat` output as a summary string, or null if there are no changes.
 * Uses execFile (not exec) to prevent shell injection.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param fromBranch - Base branch for comparison
 * @param toBranch - Target branch for comparison
 * @returns Result containing diff summary string or null if no changes
 */
export async function captureGitDiff(
  workingDirectory: string,
  fromBranch: string,
  toBranch: string,
): Promise<Result<string | null, BackbeatError>> {
  try {
    const diffResult = await execFileAsync('git', ['diff', '--stat', `${fromBranch}..${toBranch}`], {
      cwd: workingDirectory,
    });

    const summary = diffResult.stdout.trim();
    if (!summary) {
      return ok(null);
    }

    return ok(summary);
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to capture git diff (${fromBranch}..${toBranch}): ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory, fromBranch, toBranch },
      ),
    );
  }
}

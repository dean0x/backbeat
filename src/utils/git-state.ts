/**
 * Git state capture utility for task checkpoints
 * ARCHITECTURE: Captures git repository state at task terminal events
 * Pattern: Pure function returning Result, uses execFile for security (no shell injection)
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
          .trim()
          .split('\n')
          .map((line) => line.substring(3).trim()) // Remove status prefix (e.g., " M ", "?? ")
          .filter((file) => file.length > 0);
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

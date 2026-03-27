/**
 * Shared detach-mode helpers for CLI commands (run, orchestrate)
 * ARCHITECTURE: Extracts duplicated log-dir/file creation, process spawning,
 * and log-file polling into reusable functions.
 */

import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { errorMessage } from './services.js';
import * as ui from './ui.js';

// ============================================================================
// Types
// ============================================================================

export type PollResult =
  | { readonly type: 'found'; readonly id: string }
  | { readonly type: 'error'; readonly lines: readonly string[] }
  | { readonly type: 'timeout' };

export interface DetachPollOptions {
  readonly idPattern: RegExp;
  readonly errorPattern: RegExp;
  readonly foundMessage: (id: string) => string;
  readonly timeoutMessage: string;
  readonly infoLines: readonly string[];
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create the detach log directory (~/.autobeat/detach-logs/).
 * Exits the process on failure.
 */
export function createDetachLogDir(): string {
  const logDir = path.join(homedir(), '.autobeat', 'detach-logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    ui.error(`Failed to create log directory: ${logDir}: ${errorMessage(error)}`);
    process.exit(1);
  }
  return logDir;
}

/**
 * Create a uniquely-named log file in the given directory.
 * Returns the file path and open file descriptor. Exits the process on failure.
 */
export function createDetachLogFile(
  logDir: string,
  prefix: string,
): { readonly logFile: string; readonly logFd: number } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).substring(2, 8);
  const logFile = path.join(logDir, `${prefix}-${timestamp}-${suffix}.log`);
  try {
    const logFd = openSync(logFile, 'w');
    return { logFile, logFd };
  } catch (error) {
    ui.error(`Failed to create log file: ${logFile}: ${errorMessage(error)}`);
    process.exit(1);
  }
}

/**
 * Spawn a detached child process with stdout/stderr redirected to logFd.
 * Closes the file descriptor in ALL paths (success and failure) via try/finally.
 * Returns the child PID. Exits the process on failure.
 */
export function spawnDetachedProcess(childArgs: readonly string[], logFd: number): number {
  try {
    const child = spawn(process.argv[0], childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
      env: process.env,
    });

    child.unref();

    if (!child.pid) {
      ui.error('Failed to spawn background process');
      process.exit(1);
    }

    return child.pid;
  } catch (error) {
    ui.error(`Failed to spawn background process: ${errorMessage(error)}`);
    process.exit(1);
  } finally {
    closeSync(logFd);
  }
}

/**
 * Poll a log file for an ID pattern, with configurable error detection.
 * CRITICAL: Checks idPattern BEFORE errorPattern — once an ID is emitted,
 * subsequent task output may contain error-like strings (false positives).
 */
export function pollLogFileForId(logFile: string, options: DetachPollOptions): Promise<PollResult> {
  const maxAttempts = options.maxAttempts ?? 30;
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  return new Promise<PollResult>((resolve) => {
    let attempt = 0;

    const s = ui.createSpinner();
    s.start('Waiting for ID...');

    const pollInterval = setInterval(() => {
      attempt++;
      try {
        const content = readFileSync(logFile, 'utf-8');

        // Check ID pattern FIRST — task output after delegation may contain ❌
        const match = content.match(options.idPattern);
        if (match) {
          clearInterval(pollInterval);
          const id = match[1];
          s.stop(options.foundMessage(id));
          for (const line of options.infoLines) {
            ui.info(line.replace('{id}', id));
          }
          resolve({ type: 'found', id });
          return;
        }

        // Only check for errors in pre-delegation phase (no ID yet)
        if (options.errorPattern.test(content)) {
          clearInterval(pollInterval);
          s.stop('Background process error');
          const lines = content.split('\n').filter((l) => l.trim().length > 0);
          const lastLines = lines.slice(-5);
          ui.error('Background process encountered an error:');
          for (const line of lastLines) {
            process.stderr.write(`  ${line}\n`);
          }
          resolve({ type: 'error', lines: lastLines });
          return;
        }
      } catch {
        // Log file not yet readable, continue polling
      }

      if (attempt >= maxAttempts) {
        clearInterval(pollInterval);
        s.stop(options.timeoutMessage);
        ui.info(`Check log file: ${logFile}`);
        resolve({ type: 'timeout' });
      }
    }, pollIntervalMs);
  });
}

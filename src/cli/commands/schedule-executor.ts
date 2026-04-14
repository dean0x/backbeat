/**
 * Schedule auto-executor background process
 *
 * ARCHITECTURE: Hidden internal subcommand `beat schedule executor`.
 * Why: Schedule execution requires a running server process (bootstrap in 'server' mode).
 * Rather than requiring users to manually start an executor, we auto-spawn it on
 * schedule create/resume. This keeps the user-facing API clean.
 *
 * DECISION: Auto-spawn executor on create + resume.
 * Why: user shouldn't need to know about background processes. PID file race is benign —
 * per-schedule dedup in ScheduleExecutor prevents double execution even if two executors
 * start simultaneously.
 *
 * DECISION: PID file at ~/.autobeat/schedule-executor.pid.
 * Why: single global PID file per user eliminates the need for schedule-specific tracking.
 * One executor handles all active schedules.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../../bootstrap.js';
import { ScheduleStatus } from '../../core/domain.js';
import type { ScheduleRepository } from '../../core/interfaces.js';

/** Path to the PID file for the background executor process */
export function getExecutorPidPath(): string {
  const dir = path.join(os.homedir(), '.autobeat');
  return path.join(dir, 'schedule-executor.pid');
}

/** Read PID from the PID file. Returns null if file doesn't exist or is invalid. */
export function readExecutorPid(): number | null {
  const pidPath = getExecutorPidPath();
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check if a PID corresponds to a running process.
 * EPERM means the process exists but we lack permission — treated as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ensure the schedule executor is running in the background.
 * If an executor is already alive (PID file + liveness check), returns immediately.
 * Otherwise spawns a new detached background process and logs the PID.
 *
 * Called after: createSchedule, createScheduledLoop, createScheduledPipeline, resumeSchedule.
 * NOT called after: cancelSchedule, pauseSchedule (those deactivate schedules).
 */
export async function ensureScheduleExecutorRunning(): Promise<void> {
  const existingPid = readExecutorPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    // Executor is already running — nothing to do
    return;
  }

  // Stale PID file or no file — spawn a new executor
  const { spawn } = await import('node:child_process');

  // Spawn the executor as a detached background process
  // Uses the same node binary and CLI entry point we're currently running under
  const child = spawn(process.execPath, [process.argv[1], 'schedule', 'executor'], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  if (child.pid) {
    process.stderr.write(`Schedule executor started in background (PID: ${child.pid})\n`);
  }
}

/**
 * Main handler for `beat schedule executor`.
 *
 * Boots the server in 'server' mode (activates ScheduleExecutor, RecoveryManager,
 * ResourceMonitor), writes its PID to ~/.autobeat/schedule-executor.pid, and
 * keeps the process alive until all active schedules are exhausted.
 *
 * The process exits automatically when no active schedules remain (checked every 5 min).
 * SIGTERM/SIGINT trigger a clean exit with PID file cleanup.
 */
export async function handleScheduleExecutor(): Promise<void> {
  // Ensure the ~/.autobeat directory exists for the PID file
  const pidPath = getExecutorPidPath();
  const pidDir = path.dirname(pidPath);

  try {
    fs.mkdirSync(pidDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `Schedule executor: failed to create PID directory ${pidDir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Write our PID so ensureScheduleExecutorRunning() can detect us
  try {
    fs.writeFileSync(pidPath, String(process.pid), 'utf-8');
  } catch (err) {
    process.stderr.write(
      `Schedule executor: failed to write PID file ${pidPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const cleanup = (): void => {
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore cleanup errors — file may have been deleted by another process
    }
  };

  // Register signal handlers for clean exit
  const exitCleanly = (signal: string): void => {
    process.stderr.write(`Schedule executor: received ${signal}, shutting down\n`);
    cleanup();
    process.exit(0);
  };

  process.on('SIGTERM', () => exitCleanly('SIGTERM'));
  process.on('SIGINT', () => exitCleanly('SIGINT'));

  // Bootstrap in 'server' mode — activates ScheduleExecutor, RecoveryManager, monitoring
  const bootstrapResult = await bootstrap({ mode: 'server' });
  if (!bootstrapResult.ok) {
    process.stderr.write(`Schedule executor: bootstrap failed: ${bootstrapResult.error.message}\n`);
    cleanup();
    process.exit(1);
  }

  const container = bootstrapResult.value;

  // Keep process alive
  process.stdin.resume();

  // Every 5 minutes: check if any active schedules exist — exit gracefully if none
  const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const idleCheckTimer = setInterval(async () => {
    try {
      const scheduleRepoResult = container.get<ScheduleRepository>('scheduleRepository');
      if (!scheduleRepoResult.ok) {
        // Container doesn't have scheduleRepository — continue running (conservative)
        return;
      }

      const scheduleRepo = scheduleRepoResult.value;
      const activeResult = await scheduleRepo.findByStatus(ScheduleStatus.ACTIVE);
      if (activeResult.ok && activeResult.value.length === 0) {
        process.stderr.write('Schedule executor: no active schedules — exiting\n');
        clearInterval(idleCheckTimer);
        cleanup();
        process.exit(0);
      }
    } catch {
      // Error checking schedules — stay alive (conservative)
    }
  }, IDLE_CHECK_INTERVAL_MS);

  // Allow the process to exit naturally if idle check timer is the only thing keeping it alive
  // (After bootstrap completes, other timers/connections will keep process alive during execution)
  idleCheckTimer.unref();
}

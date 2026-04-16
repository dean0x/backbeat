/**
 * NoOpProcessSpawner - Test fixture for integration tests
 * Provides a ProcessSpawner that immediately completes without spawning real processes
 */

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { SpawnOptions } from '../../src/core/agents.js';
import { ProcessSpawner } from '../../src/core/interfaces.js';
import { ok, Result } from '../../src/core/result.js';

/**
 * MockChildProcess - A fake ChildProcess that simulates immediate completion
 * Used by NoOpProcessSpawner to allow dependency tests to work without hanging
 */
class MockChildProcess extends EventEmitter {
  readonly pid: number;
  readonly killed: boolean = false;
  readonly exitCode: number | null = null;

  // Required ChildProcess properties (stub implementations)
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  readonly stdio = [null, null, null, null, null] as const;
  readonly connected = false;
  readonly signalCode = null;
  readonly spawnfile = '';
  readonly spawnargs: string[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;

    // Emit exit event after a short delay to simulate process completion
    // This allows the worker pool to clean up properly without infinite loops
    setImmediate(() => {
      this.emit('exit', 0, null);
      this.emit('close', 0, null);
    });
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    return true;
  }

  ref(): void {
    /* no-op */
  }
  unref(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
  send(_message: unknown): boolean {
    return true;
  }

  // Type assertion for ChildProcess compatibility
  [Symbol.dispose](): void {
    /* no-op */
  }
}

/**
 * NoOpProcessSpawner - Prevents spawning real Claude Code instances in tests
 * Pattern: Null Object - provides safe no-op behavior for testing
 *
 * Use this in integration tests to prevent:
 * - Consuming significant CPU/memory
 * - Crashing Claude Code instances running the tests
 * - Non-deterministic test behavior
 *
 * Returns a MockChildProcess that immediately exits with code 0, allowing the
 * worker pool to handle completion properly without infinite requeue loops.
 */
export class NoOpProcessSpawner implements ProcessSpawner {
  private mockPidCounter = 90000; // High PID to avoid collision with real processes

  spawn(_options: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    const pid = this.mockPidCounter++;
    // Double assertion required: ChildProcess is a class (not interface), MockChildProcess implements all required properties
    const mockProcess = new MockChildProcess(pid) as unknown as ChildProcess;

    return ok({ process: mockProcess, pid });
  }

  kill(_pid: number): Result<void> {
    return ok(undefined);
  }

  dispose(): void {
    // No resources to clean up
  }
}

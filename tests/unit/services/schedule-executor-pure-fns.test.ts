/**
 * Tests for schedule-executor extracted pure functions (v1.3.0 batch 6)
 *
 * Tests checkActiveSchedules, registerSignalHandlers, and startIdleCheckLoop.
 *
 * ARCHITECTURE: Tests the pure DI-injectable utilities without touching global process.
 * Uses fake timers for startIdleCheckLoop, injected fake process for registerSignalHandlers,
 * and mock ScheduleRepository for checkActiveSchedules.
 *
 * Pattern: Behavioral testing — verifies observable outcomes of utility functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkActiveSchedules,
  registerSignalHandlers,
  startIdleCheckLoop,
} from '../../../src/cli/commands/schedule-executor.js';
import { ScheduleStatus } from '../../../src/core/domain.js';
import type { ScheduleRepository } from '../../../src/core/interfaces.js';
import { err, ok } from '../../../src/core/result.js';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ScheduleRepository mock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock ScheduleRepository that satisfies ScheduleRepository's
 * findByStatus method (the only method used by checkActiveSchedules).
 */
function makeScheduleRepo(
  findByStatusImpl: (status: ScheduleStatus) => ReturnType<ScheduleRepository['findByStatus']>,
): ScheduleRepository {
  return {
    findByStatus: vi.fn(findByStatusImpl),
  } as unknown as ScheduleRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkActiveSchedules
// ─────────────────────────────────────────────────────────────────────────────

describe('checkActiveSchedules', () => {
  it('returns ok(true) when active schedules exist', async () => {
    const repo = makeScheduleRepo(async () => ok([{ id: 'sched-1', status: ScheduleStatus.ACTIVE }] as never));

    const result = await checkActiveSchedules(repo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  it('returns ok(false) when no active schedules exist', async () => {
    const repo = makeScheduleRepo(async () => ok([]));

    const result = await checkActiveSchedules(repo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it('calls findByStatus with ScheduleStatus.ACTIVE', async () => {
    const findByStatus = vi.fn().mockResolvedValue(ok([]));
    const repo = { findByStatus } as unknown as ScheduleRepository;

    await checkActiveSchedules(repo);

    expect(findByStatus).toHaveBeenCalledWith(ScheduleStatus.ACTIVE);
  });

  it('returns err when findByStatus returns an error result', async () => {
    const repoError = new Error('DB connection failed');
    const repo = makeScheduleRepo(async () => err(repoError));

    const result = await checkActiveSchedules(repo);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(repoError);
  });

  it('returns err when findByStatus throws synchronously', async () => {
    const repo = {
      findByStatus: vi.fn().mockRejectedValue(new Error('unexpected throw')),
    } as unknown as ScheduleRepository;

    const result = await checkActiveSchedules(repo);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('unexpected throw');
  });

  it('wraps non-Error throws in an Error', async () => {
    const repo = {
      findByStatus: vi.fn().mockRejectedValue('string error'),
    } as unknown as ScheduleRepository;

    const result = await checkActiveSchedules(repo);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(Error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registerSignalHandlers
// ─────────────────────────────────────────────────────────────────────────────

describe('registerSignalHandlers', () => {
  /**
   * Fake process: records signal → handler registrations.
   * Injected instead of global `process` to avoid polluting signal handlers between tests.
   */
  function makeFakeProc(): {
    on: ReturnType<typeof vi.fn>;
    handlers: Record<string, (() => void)[]>;
    emit: (signal: string) => void;
  } {
    const handlers: Record<string, (() => void)[]> = {};
    const on = vi.fn((signal: string, handler: () => void) => {
      handlers[signal] = handlers[signal] ?? [];
      handlers[signal].push(handler);
    });
    return {
      on,
      handlers,
      emit: (signal: string) => {
        for (const h of handlers[signal] ?? []) h();
      },
    };
  }

  it('registers a SIGTERM handler on the injected process', () => {
    const fakeProc = makeFakeProc();
    registerSignalHandlers(() => {}, fakeProc);

    expect(fakeProc.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('registers a SIGINT handler on the injected process', () => {
    const fakeProc = makeFakeProc();
    registerSignalHandlers(() => {}, fakeProc);

    expect(fakeProc.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('registers exactly two handlers (SIGTERM and SIGINT)', () => {
    const fakeProc = makeFakeProc();
    registerSignalHandlers(() => {}, fakeProc);

    expect(fakeProc.on).toHaveBeenCalledTimes(2);
  });

  it('calls cleanup when SIGTERM fires', () => {
    const fakeProc = makeFakeProc();
    const cleanup = vi.fn();
    const fakeExit = vi.fn();

    registerSignalHandlers(cleanup, fakeProc, fakeExit);
    fakeProc.emit('SIGTERM');

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('calls cleanup when SIGINT fires', () => {
    const fakeProc = makeFakeProc();
    const cleanup = vi.fn();
    const fakeExit = vi.fn();

    registerSignalHandlers(cleanup, fakeProc, fakeExit);
    fakeProc.emit('SIGINT');

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleanup is called before exit', () => {
    const fakeProc = makeFakeProc();
    const callOrder: string[] = [];
    const cleanup = vi.fn(() => callOrder.push('cleanup'));
    const fakeExit = vi.fn(() => callOrder.push('exit'));

    registerSignalHandlers(cleanup, fakeProc, fakeExit);
    fakeProc.emit('SIGTERM');

    expect(callOrder).toEqual(['cleanup', 'exit']);
  });

  it('calls exit(0) when signal fires', () => {
    const fakeProc = makeFakeProc();
    const fakeExit = vi.fn();

    registerSignalHandlers(() => {}, fakeProc, fakeExit);
    fakeProc.emit('SIGTERM');

    expect(fakeExit).toHaveBeenCalledWith(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startIdleCheckLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('startIdleCheckLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a timer handle (NodeJS.Timeout)', () => {
    const repo = makeScheduleRepo(async () => ok([]));
    const timer = startIdleCheckLoop(
      repo,
      1000,
      () => {},
      () => {},
    );
    expect(timer).toBeDefined();
    clearInterval(timer);
  });

  it('does NOT call onIdle before the interval fires', async () => {
    const repo = makeScheduleRepo(async () => ok([]));
    const onIdle = vi.fn();

    const timer = startIdleCheckLoop(repo, 5000, onIdle, () => {});

    // Advance time by less than the interval
    await vi.advanceTimersByTimeAsync(4999);
    expect(onIdle).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('calls onIdle when interval fires and no active schedules exist', async () => {
    const repo = makeScheduleRepo(async () => ok([]));
    const onIdle = vi.fn();

    const timer = startIdleCheckLoop(repo, 1000, onIdle, () => {});

    await vi.advanceTimersByTimeAsync(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });

  it('does NOT call onIdle when active schedules exist', async () => {
    const repo = makeScheduleRepo(async () => ok([{ id: 'sched-1', status: ScheduleStatus.ACTIVE }] as never));
    const onIdle = vi.fn();

    const timer = startIdleCheckLoop(repo, 1000, onIdle, () => {});

    await vi.advanceTimersByTimeAsync(1000);
    expect(onIdle).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('calls warn when onIdle is triggered (no active schedules)', async () => {
    const repo = makeScheduleRepo(async () => ok([]));
    const warn = vi.fn();

    const timer = startIdleCheckLoop(repo, 1000, () => {}, warn);

    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no active schedules'));
    clearInterval(timer);
  });

  it('does NOT call warn when active schedules exist', async () => {
    const repo = makeScheduleRepo(async () => ok([{ id: 'sched-1', status: ScheduleStatus.ACTIVE }] as never));
    const warn = vi.fn();

    const timer = startIdleCheckLoop(repo, 1000, () => {}, warn);

    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('stays alive on repo error (conservative — does not call onIdle or warn)', async () => {
    const repo = makeScheduleRepo(async () => err(new Error('DB error')));
    const onIdle = vi.fn();
    const warn = vi.fn();

    const timer = startIdleCheckLoop(repo, 1000, onIdle, warn);

    await vi.advanceTimersByTimeAsync(1000);
    // On error: stay alive — no onIdle, no warn
    expect(onIdle).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('fires multiple times at the configured interval', async () => {
    let callCount = 0;
    const repo = makeScheduleRepo(async () => {
      callCount++;
      return ok([{ id: 'sched-1' }] as never); // active schedules — won't call onIdle
    });

    const timer = startIdleCheckLoop(
      repo,
      1000,
      () => {},
      () => {},
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(callCount).toBe(3);
    clearInterval(timer);
  });

  it('timer can be cleared to prevent further onIdle calls', async () => {
    const repo = makeScheduleRepo(async () => ok([]));
    const onIdle = vi.fn();

    const timer = startIdleCheckLoop(repo, 1000, onIdle, () => {});

    // Fire once
    await vi.advanceTimersByTimeAsync(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    // Clear timer — subsequent intervals should not fire
    clearInterval(timer);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onIdle).toHaveBeenCalledTimes(1); // still 1, not 2 or 3
  });
});

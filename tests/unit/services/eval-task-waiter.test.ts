/**
 * Unit tests for waitForEvalTaskCompletion (eval-task-waiter)
 *
 * ARCHITECTURE: Tests the shared event-subscription pattern used by all three
 * exit condition evaluators. Verifies terminal event resolution, cleanup,
 * fallback timer, and loop-cancellation propagation.
 *
 * Pattern: Behavioral testing with TestEventBus (DI pattern — no real EventBus overhead).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoopId, TaskId } from '../../../src/core/domain.js';
import type { TaskCompletionStatus } from '../../../src/services/eval-task-waiter.js';
import { waitForEvalTaskCompletion } from '../../../src/services/eval-task-waiter.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeContext(): { eventBus: TestEventBus; logger: TestLogger } {
  return {
    eventBus: new TestEventBus(),
    logger: new TestLogger(),
  };
}

const EVAL_TASK_ID = TaskId('eval-task-1');
const OTHER_TASK_ID = TaskId('other-task-99');
const LOOP_ID = LoopId('loop-1');
const OTHER_LOOP_ID = LoopId('loop-other');
const EVAL_TIMEOUT_MS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Terminal event handling
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForEvalTaskCompletion — terminal events', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    context = makeContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    context.eventBus.dispose();
  });

  it('resolves with { type: completed } when TaskCompleted fires for the eval task', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('TaskCompleted', { taskId: EVAL_TASK_ID, exitCode: 0, duration: 100 });

    const result: TaskCompletionStatus = await promise;
    expect(result).toEqual({ type: 'completed' });
  });

  it('resolves with { type: failed, error } when TaskFailed fires for the eval task', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('TaskFailed', {
      taskId: EVAL_TASK_ID,
      error: { message: 'process exited with code 1', code: 'EXEC_ERROR' },
      exitCode: 1,
    });

    const result = await promise;
    expect(result).toEqual({ type: 'failed', error: 'process exited with code 1' });
  });

  it('resolves with { type: failed } with no error when TaskFailed has no error object', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('TaskFailed', {
      taskId: EVAL_TASK_ID,
      exitCode: 1,
    });

    const result = await promise;
    expect(result).toEqual({ type: 'failed', error: undefined });
  });

  it('resolves with { type: cancelled } when TaskCancelled fires for the eval task', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('TaskCancelled', { taskId: EVAL_TASK_ID });

    const result = await promise;
    expect(result).toEqual({ type: 'cancelled' });
  });

  it('resolves with { type: timeout } when TaskTimeout fires for the eval task', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('TaskTimeout', { taskId: EVAL_TASK_ID });

    const result = await promise;
    expect(result).toEqual({ type: 'timeout' });
  });

  it('ignores events for other task IDs', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    // Fire events for a different task — should not resolve the promise
    await context.eventBus.emit('TaskCompleted', { taskId: OTHER_TASK_ID, exitCode: 0, duration: 100 });
    await context.eventBus.emit('TaskFailed', {
      taskId: OTHER_TASK_ID,
      error: { message: 'other fail', code: 'ERR' },
      exitCode: 1,
    });

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    // Advance past grace period to ensure the promise has NOT resolved
    vi.advanceTimersByTime(10);
    await Promise.resolve();

    expect(resolved).toBe(false);

    // Clean up: resolve via the correct task ID
    await context.eventBus.emit('TaskCompleted', { taskId: EVAL_TASK_ID, exitCode: 0, duration: 0 });
    await promise;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveOnce — idempotent guard
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForEvalTaskCompletion — resolveOnce idempotency', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    context = makeContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    context.eventBus.dispose();
  });

  it('does not resolve twice when two terminal events arrive for the same task', async () => {
    const results: TaskCompletionStatus[] = [];
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);
    promise.then((r) => results.push(r));

    await context.eventBus.emit('TaskCompleted', { taskId: EVAL_TASK_ID, exitCode: 0, duration: 0 });
    await context.eventBus.emit('TaskFailed', {
      taskId: EVAL_TASK_ID,
      error: { message: 'late fail', code: 'ERR' },
      exitCode: 1,
    });
    await promise;

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: 'completed' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback timer
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForEvalTaskCompletion — fallback timer', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    context = makeContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    context.eventBus.dispose();
  });

  it('resolves with { type: timeout } when fallback timer fires (evalTimeout + 5000ms)', async () => {
    const evalTimeout = 2000;
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, evalTimeout, LOOP_ID, context);

    // Before grace period — should not have resolved
    vi.advanceTimersByTime(evalTimeout + 4999);
    await Promise.resolve();

    // Exactly at evalTimeout + 5000ms — fallback fires
    vi.advanceTimersByTime(1);
    await Promise.resolve();

    const result = await promise;
    expect(result).toEqual({ type: 'timeout' });
  });

  it('logs a warning when the fallback timer fires', async () => {
    const evalTimeout = 500;
    waitForEvalTaskCompletion(EVAL_TASK_ID, evalTimeout, LOOP_ID, context);

    vi.advanceTimersByTime(evalTimeout + 5000 + 1);
    await Promise.resolve();

    expect(context.logger.hasLogContaining('Eval task completion timed out by fallback timer')).toBe(true);
  });

  it('cancels fallback timer when a terminal event resolves the promise first', async () => {
    const evalTimeout = 5000;
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, evalTimeout, LOOP_ID, context);

    await context.eventBus.emit('TaskCompleted', { taskId: EVAL_TASK_ID, exitCode: 0, duration: 0 });
    const result = await promise;

    // Advance past the full grace period — no second resolution should occur
    vi.advanceTimersByTime(evalTimeout + 5001);
    await Promise.resolve();

    expect(result).toEqual({ type: 'completed' });
    // logger should NOT have the timeout warning
    expect(context.logger.hasLogContaining('Eval task completion timed out by fallback timer')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Loop cancellation propagation
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForEvalTaskCompletion — loop cancellation propagation', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    context = makeContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    context.eventBus.dispose();
  });

  it('emits TaskCancellationRequested for the eval task when the parent loop is cancelled', async () => {
    waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('LoopCancelled', { loopId: LOOP_ID });

    const emitted = context.eventBus.getAllEmittedEvents();
    const cancellationReq = emitted.find((e) => e.type === 'TaskCancellationRequested');
    expect(cancellationReq).toBeDefined();
    expect((cancellationReq!.payload as { taskId: string }).taskId).toBe(EVAL_TASK_ID);
  });

  it('logs when loop cancellation triggers eval task cancellation', async () => {
    waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('LoopCancelled', { loopId: LOOP_ID });

    expect(context.logger.hasLogContaining('Loop cancelled while eval task running — cancelling eval task')).toBe(true);
  });

  it('ignores LoopCancelled events for other loops', async () => {
    waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    await context.eventBus.emit('LoopCancelled', { loopId: OTHER_LOOP_ID });

    const emitted = context.eventBus.getAllEmittedEvents();
    const cancellationReq = emitted.find((e) => e.type === 'TaskCancellationRequested');
    expect(cancellationReq).toBeUndefined();

    // Clean up
    await context.eventBus.emit('TaskCompleted', { taskId: EVAL_TASK_ID, exitCode: 0, duration: 0 });
  });

  it('resolves with { type: cancelled } after loop cancellation triggers TaskCancelled', async () => {
    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    // Step 1: loop is cancelled → handler emits TaskCancellationRequested
    await context.eventBus.emit('LoopCancelled', { loopId: LOOP_ID });

    // Step 2: worker processes the request and emits TaskCancelled
    await context.eventBus.emit('TaskCancelled', { taskId: EVAL_TASK_ID });

    const result = await promise;
    expect(result).toEqual({ type: 'cancelled' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subscription cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForEvalTaskCompletion — subscription cleanup', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    context = makeContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    context.eventBus.dispose();
  });

  it('cleans up subscriptions after TaskCompleted resolves the promise', async () => {
    const unsubscribeSpy = vi.spyOn(context.eventBus, 'unsubscribe');

    const promise = waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);
    await context.eventBus.emit('TaskCompleted', { taskId: EVAL_TASK_ID, exitCode: 0, duration: 0 });
    await promise;

    // Five subscriptions registered (TaskCompleted, TaskFailed, TaskCancelled, TaskTimeout, LoopCancelled)
    expect(unsubscribeSpy).toHaveBeenCalledTimes(5);
  });

  it('cleans up subscriptions after fallback timer fires', async () => {
    const unsubscribeSpy = vi.spyOn(context.eventBus, 'unsubscribe');

    waitForEvalTaskCompletion(EVAL_TASK_ID, EVAL_TIMEOUT_MS, LOOP_ID, context);

    vi.advanceTimersByTime(EVAL_TIMEOUT_MS + 5001);
    await Promise.resolve();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(5);
  });
});

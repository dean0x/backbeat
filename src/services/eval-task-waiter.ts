/**
 * Shared eval-task completion waiter for exit condition evaluators
 *
 * ARCHITECTURE: All three evaluators (AgentExitConditionEvaluator,
 * FeedforwardEvaluator, JudgeExitConditionEvaluator) wait for a spawned
 * eval task to reach a terminal state using the same pattern:
 * subscribe to task events, cancel on loop cancel, fall back to a timer.
 *
 * Extracted here to eliminate triplication without changing behavior.
 * Pattern: Function over inheritance — injected deps, no shared base class.
 */

import type { LoopId, TaskId } from '../core/domain.js';
import { EventBus } from '../core/events/event-bus.js';
import type {
  LoopCancelledEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskTimeoutEvent,
} from '../core/events/events.js';
import type { Logger } from '../core/interfaces.js';

export type TaskCompletionStatus =
  | { type: 'completed' }
  | { type: 'failed'; error?: string }
  | { type: 'timeout' }
  | { type: 'cancelled' };

/**
 * Wait for an eval task to reach a terminal state.
 *
 * Subscribes to all task terminal events for evalTaskId.
 * Cancels the eval task immediately if the parent loop is cancelled,
 * rather than waiting up to evalTimeout as an orphan.
 * Uses .unref() on the fallback timer to not block process exit.
 *
 * @param evalTaskId - The eval task to wait for
 * @param evalTimeout - Expected max duration; fallback fires at evalTimeout + 5000ms
 * @param loopId - Parent loop; if cancelled, eval task receives TaskCancellationRequested
 * @param context - Logger and EventBus for subscriptions and cleanup
 */
export function waitForEvalTaskCompletion(
  evalTaskId: TaskId,
  evalTimeout: number,
  loopId: LoopId,
  context: { eventBus: EventBus; logger: Logger },
): Promise<TaskCompletionStatus> {
  const { eventBus, logger } = context;

  return new Promise((resolve) => {
    const subscriptionIds: string[] = [];
    let resolved = false;

    const cleanup = (): void => {
      for (const subId of subscriptionIds) {
        eventBus.unsubscribe(subId);
      }
    };

    const resolveOnce = (result: TaskCompletionStatus): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const completedSub = eventBus.subscribe<TaskCompletedEvent>('TaskCompleted', async (event) => {
      if (event.taskId === evalTaskId) resolveOnce({ type: 'completed' });
    });

    const failedSub = eventBus.subscribe<TaskFailedEvent>('TaskFailed', async (event) => {
      if (event.taskId === evalTaskId) resolveOnce({ type: 'failed', error: event.error?.message });
    });

    const cancelledSub = eventBus.subscribe<TaskCancelledEvent>('TaskCancelled', async (event) => {
      if (event.taskId === evalTaskId) resolveOnce({ type: 'cancelled' });
    });

    const timeoutSub = eventBus.subscribe<TaskTimeoutEvent>('TaskTimeout', async (event) => {
      if (event.taskId === evalTaskId) resolveOnce({ type: 'timeout' });
    });

    // Cancel orphaned eval task when parent loop is cancelled.
    // The eval task is not tracked in LoopHandler.taskToLoop by design, so
    // handleLoopCancelled cannot reach it. Emit TaskCancellationRequested here
    // to free the worker slot immediately rather than waiting for evalTimeout.
    // resolveOnce fires once TaskCancelled arrives for evalTaskId above.
    const loopCancelledSub = eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) => {
      if (event.loopId !== loopId) return;
      logger.info('Loop cancelled while eval task running — cancelling eval task', { loopId, evalTaskId });
      await eventBus.emit('TaskCancellationRequested', {
        taskId: evalTaskId,
        reason: `Loop ${loopId} cancelled`,
      });
    });

    if (completedSub.ok) subscriptionIds.push(completedSub.value);
    if (failedSub.ok) subscriptionIds.push(failedSub.value);
    if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);
    if (timeoutSub.ok) subscriptionIds.push(timeoutSub.value);
    if (loopCancelledSub.ok) subscriptionIds.push(loopCancelledSub.value);

    // Fallback timer: evalTimeout + 5000ms grace period
    const timer = setTimeout(() => {
      logger.warn('Eval task completion timed out by fallback timer', { evalTaskId, evalTimeout });
      resolveOnce({ type: 'timeout' });
    }, evalTimeout + 5_000);

    // Don't block process exit
    timer.unref();
  });
}

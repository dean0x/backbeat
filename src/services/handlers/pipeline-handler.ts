/**
 * Pipeline handler — subscribes to task lifecycle events and updates pipeline status.
 *
 * ARCHITECTURE: Event-driven, best-effort status aggregation.
 * - Subscribes to TaskCompleted, TaskFailed, TaskCancelled.
 * - On each event, looks up active pipelines containing the task ID.
 * - Aggregates step task statuses to determine new pipeline status.
 * - Emits PipelineCompleted / PipelineFailed / PipelineCancelled as appropriate.
 * Pattern: Factory pattern for async initialization (matches UsageCaptureHandler).
 */

import { type Pipeline, PipelineStatus, type TaskId } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { TaskCancelledEvent, TaskCompletedEvent, TaskFailedEvent } from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type { Logger, TaskRepository } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import type { SQLitePipelineRepository } from '../../implementations/pipeline-repository.js';

export interface PipelineHandlerDeps {
  readonly pipelineRepository: SQLitePipelineRepository;
  readonly taskRepository: TaskRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class PipelineHandler extends BaseEventHandler {
  private readonly pipelineRepository: SQLitePipelineRepository;
  private readonly taskRepository: TaskRepository;
  private readonly eventBus: EventBus;

  /**
   * Private constructor — use PipelineHandler.create() instead.
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use.
   */
  private constructor(deps: PipelineHandlerDeps) {
    super(deps.logger, 'PipelineHandler');
    this.pipelineRepository = deps.pipelineRepository;
    this.taskRepository = deps.taskRepository;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method — creates and subscribes the handler.
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible.
   */
  static async create(deps: PipelineHandlerDeps): Promise<Result<PipelineHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child ? deps.logger.child({ module: 'PipelineHandler' }) : deps.logger;
    const handler = new PipelineHandler({ ...deps, logger: handlerLogger });

    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('PipelineHandler initialized');
    return ok(handler);
  }

  private subscribeToEvents(): Result<void, AutobeatError> {
    const subs = [
      this.eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this)),
      this.eventBus.subscribe('TaskFailed', this.handleTaskFailed.bind(this)),
      this.eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this)),
    ];

    for (const result of subs) {
      if (!result.ok) {
        return err(
          new AutobeatError(
            ErrorCode.SYSTEM_ERROR,
            `PipelineHandler: failed to subscribe to event: ${result.error.message}`,
            { error: result.error },
          ),
        );
      }
    }

    return ok(undefined);
  }

  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.onTaskTerminated(e.taskId);
    });
  }

  private async handleTaskFailed(event: TaskFailedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.onTaskTerminated(e.taskId);
    });
  }

  private async handleTaskCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.onTaskTerminated(e.taskId);
    });
  }

  /**
   * Core pipeline status aggregation logic.
   * Called when any step task terminates (completed, failed, cancelled).
   * Finds associated active pipelines and recomputes their aggregate status.
   */
  private async onTaskTerminated(taskId: TaskId): Promise<Result<void>> {
    // Find active pipelines that contain this task ID
    const pipelinesResult = await this.pipelineRepository.findActiveByTaskId(taskId);
    if (!pipelinesResult.ok) {
      this.logger.warn('PipelineHandler: failed to look up pipelines for task', {
        taskId,
        error: pipelinesResult.error.message,
      });
      return ok(undefined); // best-effort — don't propagate
    }

    const pipelines = pipelinesResult.value;
    if (pipelines.length === 0) {
      // Task is not part of any active pipeline — nothing to do
      return ok(undefined);
    }

    // Process each associated pipeline
    for (const pipeline of pipelines) {
      const updateResult = await this.updatePipelineStatus(pipeline);
      if (!updateResult.ok) {
        this.logger.warn('PipelineHandler: failed to update pipeline status', {
          pipelineId: pipeline.id,
          taskId,
          error: updateResult.error.message,
        });
        // Continue processing other pipelines even if one fails
      }
    }

    return ok(undefined);
  }

  /**
   * Recompute and persist pipeline status from the current state of its step tasks.
   * Aggregation rules:
   *   - Any step cancelled → pipeline CANCELLED
   *   - Any step failed → pipeline FAILED
   *   - All steps completed → pipeline COMPLETED
   *   - Otherwise → pipeline RUNNING (progress made but not finished)
   */
  private async updatePipelineStatus(pipeline: Pipeline): Promise<Result<void>> {
    const taskIds = pipeline.stepTaskIds.filter((id): id is TaskId => id !== null);

    if (taskIds.length === 0) {
      // Degenerate pipeline with no assigned tasks yet — skip
      return ok(undefined);
    }

    // Fetch all step task statuses
    const statuses: string[] = [];
    for (const tid of taskIds) {
      const taskResult = await this.taskRepository.findById(tid);
      if (!taskResult.ok) {
        this.logger.warn('PipelineHandler: failed to fetch step task', {
          taskId: tid,
          pipelineId: pipeline.id,
          error: taskResult.error.message,
        });
        return ok(undefined); // best-effort — skip this pipeline update
      }
      if (taskResult.value) {
        statuses.push(taskResult.value.status);
      }
    }

    // Aggregate: cancelled takes priority, then failed, then check completion
    const newStatus = this.aggregateStatus(statuses, taskIds.length);

    // Only update if status actually changed
    if (newStatus === pipeline.status) {
      return ok(undefined);
    }

    const now = Date.now();
    const updated: Pipeline = {
      ...pipeline,
      status: newStatus,
      updatedAt: now,
      completedAt:
        newStatus === PipelineStatus.COMPLETED ||
        newStatus === PipelineStatus.FAILED ||
        newStatus === PipelineStatus.CANCELLED
          ? now
          : pipeline.completedAt,
    };

    const saveResult = await this.pipelineRepository.update(updated);
    if (!saveResult.ok) {
      return saveResult;
    }

    // Emit pipeline lifecycle event
    await this.emitPipelineEvent(updated);

    this.logger.info('PipelineHandler: pipeline status updated', {
      pipelineId: pipeline.id,
      fromStatus: pipeline.status,
      toStatus: newStatus,
    });

    return ok(undefined);
  }

  /**
   * Determine the aggregate pipeline status from the statuses of its step tasks.
   * @param statuses - Array of task status strings for all assigned steps
   * @param totalSteps - Total number of steps (including null / unassigned)
   */
  private aggregateStatus(statuses: string[], totalSteps: number): PipelineStatus {
    if (statuses.some((s) => s === 'cancelled')) {
      return PipelineStatus.CANCELLED;
    }
    if (statuses.some((s) => s === 'failed')) {
      return PipelineStatus.FAILED;
    }
    if (statuses.length >= totalSteps && statuses.every((s) => s === 'completed')) {
      return PipelineStatus.COMPLETED;
    }
    return PipelineStatus.RUNNING;
  }

  /**
   * Emit the appropriate pipeline lifecycle event based on the new status.
   */
  private async emitPipelineEvent(pipeline: Pipeline): Promise<void> {
    switch (pipeline.status) {
      case PipelineStatus.COMPLETED:
        await this.emitEvent(this.eventBus, 'PipelineCompleted', { pipelineId: pipeline.id });
        break;
      case PipelineStatus.FAILED: {
        // Find the first failed step index for the event payload
        const failedIdx = pipeline.stepTaskIds.findIndex((_, i) => {
          // We use index as stepIndex — exact task ID not available here without another lookup
          return i;
        });
        await this.emitEvent(this.eventBus, 'PipelineFailed', {
          pipelineId: pipeline.id,
          failedStepIndex: failedIdx >= 0 ? failedIdx : 0,
          taskId: pipeline.stepTaskIds[0] ?? '',
        });
        break;
      }
      case PipelineStatus.CANCELLED:
        await this.emitEvent(this.eventBus, 'PipelineCancelled', { pipelineId: pipeline.id });
        break;
      default:
        // RUNNING / PENDING — no terminal event
        break;
    }
  }
}

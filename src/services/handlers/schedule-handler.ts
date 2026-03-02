/**
 * Schedule handler for task scheduling management
 * ARCHITECTURE: Event-driven schedule lifecycle management
 * Pattern: Factory pattern for async initialization (matches DependencyHandler)
 * Rationale: Manages schedule creation, triggering, pausing, and execution tracking
 */

import type { Schedule } from '../../core/domain.js';
import { createTask, isTerminalState, ScheduleStatus, ScheduleType, updateSchedule } from '../../core/domain.js';
import { BackbeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import {
  ScheduleCancelledEvent,
  ScheduleCreatedEvent,
  SchedulePausedEvent,
  ScheduleQueryEvent,
  ScheduleResumedEvent,
  ScheduleTriggeredEvent,
  ScheduleUpdatedEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { Logger, ScheduleRepository, TaskRepository } from '../../core/interfaces.js';
import { err, ok, Result } from '../../core/result.js';
import { getNextRunTime, isValidTimezone, validateCronExpression } from '../../utils/cron.js';

/**
 * Options for ScheduleHandler configuration
 */
export interface ScheduleHandlerOptions {
  /** Default timezone for schedules without explicit timezone. Default: 'UTC' */
  readonly defaultTimezone?: string;
}

export class ScheduleHandler extends BaseEventHandler {
  private readonly defaultTimezone: string;

  /**
   * Private constructor - use ScheduleHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(
    private readonly scheduleRepo: ScheduleRepository,
    private readonly taskRepo: TaskRepository,
    private readonly eventBus: EventBus,
    logger: Logger,
    options?: ScheduleHandlerOptions,
  ) {
    super(logger, 'ScheduleHandler');
    this.defaultTimezone = options?.defaultTimezone ?? 'UTC';
  }

  /**
   * Factory method to create a fully initialized ScheduleHandler
   * ARCHITECTURE: Guarantees handler is ready to use - no uninitialized state possible
   *
   * @param scheduleRepo - Repository for schedule persistence
   * @param taskRepo - Repository for task creation when schedule triggers
   * @param eventBus - Event bus for subscriptions
   * @param logger - Logger instance
   * @param options - Optional configuration
   * @returns Result containing initialized handler or error
   */
  static async create(
    scheduleRepo: ScheduleRepository,
    taskRepo: TaskRepository,
    eventBus: EventBus,
    logger: Logger,
    options?: ScheduleHandlerOptions,
  ): Promise<Result<ScheduleHandler, BackbeatError>> {
    const handlerLogger = logger.child ? logger.child({ module: 'ScheduleHandler' }) : logger;

    // Create handler
    const handler = new ScheduleHandler(scheduleRepo, taskRepo, eventBus, handlerLogger, options);

    // Subscribe to events
    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('ScheduleHandler initialized', {
      defaultTimezone: handler.defaultTimezone,
    });

    return ok(handler);
  }

  /**
   * Subscribe to all relevant events
   * ARCHITECTURE: Called by factory after initialization
   */
  private subscribeToEvents(): Result<void, BackbeatError> {
    const subscriptions = [
      // Schedule lifecycle events
      this.eventBus.subscribe('ScheduleCreated', this.handleScheduleCreated.bind(this)),
      this.eventBus.subscribe('ScheduleTriggered', this.handleScheduleTriggered.bind(this)),
      this.eventBus.subscribe('ScheduleCancelled', this.handleScheduleCancelled.bind(this)),
      this.eventBus.subscribe('SchedulePaused', this.handleSchedulePaused.bind(this)),
      this.eventBus.subscribe('ScheduleResumed', this.handleScheduleResumed.bind(this)),
      this.eventBus.subscribe('ScheduleUpdated', this.handleScheduleUpdated.bind(this)),
      // Query events
      this.eventBus.subscribe('ScheduleQuery', this.handleScheduleQuery.bind(this)),
    ];

    // Check if any subscription failed
    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to events: ${result.error.message}`, {
            error: result.error,
          }),
        );
      }
    }

    return ok(undefined);
  }

  // ============================================================================
  // SCHEDULE LIFECYCLE EVENT HANDLERS
  // ============================================================================

  /**
   * Handle schedule creation - validate, calculate nextRunAt, persist
   */
  private async handleScheduleCreated(event: ScheduleCreatedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const schedule = e.schedule;

      this.logger.info('Processing new schedule', {
        scheduleId: schedule.id,
        type: schedule.scheduleType,
        timezone: schedule.timezone,
      });

      // Validate timezone
      if (!isValidTimezone(schedule.timezone)) {
        this.logger.error('Invalid timezone for schedule', undefined, {
          scheduleId: schedule.id,
          timezone: schedule.timezone,
        });
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, `Invalid timezone: ${schedule.timezone}`, {
            scheduleId: schedule.id,
            timezone: schedule.timezone,
          }),
        );
      }

      // Validate and calculate nextRunAt based on schedule type
      let nextRunAt: number | undefined;

      if (schedule.scheduleType === ScheduleType.CRON) {
        // Validate cron expression
        if (!schedule.cronExpression) {
          return err(
            new BackbeatError(ErrorCode.INVALID_INPUT, 'CRON schedule requires cronExpression', {
              scheduleId: schedule.id,
            }),
          );
        }

        const cronValidation = validateCronExpression(schedule.cronExpression);
        if (!cronValidation.ok) {
          this.logger.error('Invalid cron expression', cronValidation.error, {
            scheduleId: schedule.id,
            cronExpression: schedule.cronExpression,
          });
          return cronValidation;
        }

        // Calculate first run time
        const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone);
        if (!nextResult.ok) {
          return nextResult;
        }
        nextRunAt = nextResult.value;
      } else if (schedule.scheduleType === ScheduleType.ONE_TIME) {
        // ONE_TIME uses scheduledAt directly
        if (!schedule.scheduledAt) {
          return err(
            new BackbeatError(ErrorCode.INVALID_INPUT, 'ONE_TIME schedule requires scheduledAt timestamp', {
              scheduleId: schedule.id,
            }),
          );
        }
        nextRunAt = schedule.scheduledAt;
      } else {
        const _exhaustive: never = schedule.scheduleType;
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, `Unknown schedule type: ${schedule.scheduleType}`, {
            scheduleId: schedule.id,
          }),
        );
      }

      // Update schedule with calculated nextRunAt and save
      const updatedSchedule = updateSchedule(schedule, { nextRunAt });
      const saveResult = await this.scheduleRepo.save(updatedSchedule);
      if (!saveResult.ok) {
        this.logger.error('Failed to save schedule', saveResult.error, {
          scheduleId: schedule.id,
        });
        return saveResult;
      }

      this.logger.info('Schedule created and persisted', {
        scheduleId: schedule.id,
        nextRunAt,
        nextRunAtDate: nextRunAt ? new Date(nextRunAt).toISOString() : 'none',
      });

      return ok(undefined);
    });
  }

  /**
   * Handle schedule trigger - create task, record execution, update schedule
   */
  private async handleScheduleTriggered(event: ScheduleTriggeredEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, triggeredAt } = e;

      this.logger.info('Processing schedule trigger', {
        scheduleId,
        triggeredAt,
        triggeredAtDate: new Date(triggeredAt).toISOString(),
      });

      // Fetch schedule
      const scheduleResult = await this.scheduleRepo.findById(scheduleId);
      if (!scheduleResult.ok) {
        return scheduleResult;
      }

      const schedule = scheduleResult.value;
      if (!schedule) {
        return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${scheduleId} not found`, { scheduleId }));
      }

      // Check if schedule is still active
      if (schedule.status !== ScheduleStatus.ACTIVE) {
        this.logger.warn('Schedule is not active, skipping trigger', {
          scheduleId,
          status: schedule.status,
        });
        return ok(undefined);
      }

      // afterScheduleId enforcement: inject dependency on chained schedule's latest task
      let taskTemplate = schedule.taskTemplate;

      if (schedule.afterScheduleId) {
        const historyResult = await this.scheduleRepo.getExecutionHistory(schedule.afterScheduleId, 1);

        if (historyResult.ok && historyResult.value.length > 0) {
          const latestExecution = historyResult.value[0];

          if (latestExecution.taskId) {
            const depTaskResult = await this.taskRepo.findById(latestExecution.taskId);

            if (depTaskResult.ok && depTaskResult.value && !isTerminalState(depTaskResult.value.status)) {
              taskTemplate = {
                ...schedule.taskTemplate,
                dependsOn: [...(schedule.taskTemplate.dependsOn ?? []), latestExecution.taskId],
              };
              this.logger.info('Injected afterSchedule dependency', {
                scheduleId,
                afterScheduleId: schedule.afterScheduleId,
                dependsOnTaskId: latestExecution.taskId,
              });
            } else {
              this.logger.info('afterSchedule dependency already resolved, skipping', {
                scheduleId,
                afterScheduleId: schedule.afterScheduleId,
                taskId: latestExecution.taskId,
                taskStatus: depTaskResult.ok ? (depTaskResult.value?.status ?? 'not-found') : 'lookup-failed',
              });
            }
          }
          // No taskId on execution (failed before creating task) → skip
        }
        // No execution history → nothing to chain after
      }

      // Create task from template
      const task = createTask(taskTemplate);
      const taskSaveResult = await this.taskRepo.save(task);
      if (!taskSaveResult.ok) {
        // Record failed execution (audit trail - log on failure but don't block)
        const failedExecResult = await this.scheduleRepo.recordExecution({
          scheduleId,
          scheduledFor: schedule.nextRunAt ?? triggeredAt,
          executedAt: triggeredAt,
          status: 'failed',
          errorMessage: `Failed to create task: ${taskSaveResult.error.message}`,
          createdAt: Date.now(),
        });
        if (!failedExecResult.ok) {
          this.logger.error('Failed to record failed execution', failedExecResult.error, { scheduleId });
        }
        return taskSaveResult;
      }

      // Record successful execution (audit trail - log on failure but don't block)
      const execResult = await this.scheduleRepo.recordExecution({
        scheduleId,
        taskId: task.id,
        scheduledFor: schedule.nextRunAt ?? triggeredAt,
        executedAt: triggeredAt,
        status: 'triggered',
        createdAt: Date.now(),
      });
      if (!execResult.ok) {
        this.logger.error('Failed to record triggered execution', execResult.error, { scheduleId });
      }

      // Calculate update fields for schedule
      const newRunCount = schedule.runCount + 1;

      // Determine new status and nextRunAt
      let newStatus: ScheduleStatus | undefined;
      let newNextRunAt: number | undefined;

      // Calculate next run time for CRON schedules
      if (schedule.scheduleType === ScheduleType.CRON && schedule.cronExpression) {
        const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone);
        if (nextResult.ok) {
          newNextRunAt = nextResult.value;
        } else {
          this.logger.error('Failed to calculate next run, pausing schedule', nextResult.error, {
            scheduleId,
            cronExpression: schedule.cronExpression,
          });
          newStatus = ScheduleStatus.PAUSED;
          // newNextRunAt remains undefined -- will be explicitly set below to clear nextRunAt
        }
      } else if (schedule.scheduleType === ScheduleType.ONE_TIME) {
        // ONE_TIME schedules complete after single execution
        newStatus = ScheduleStatus.COMPLETED;
        newNextRunAt = undefined;
      }

      // Check if maxRuns reached
      if (schedule.maxRuns && newRunCount >= schedule.maxRuns) {
        newStatus = ScheduleStatus.COMPLETED;
        newNextRunAt = undefined;
        this.logger.info('Schedule reached maxRuns, marking completed', {
          scheduleId,
          runCount: newRunCount,
          maxRuns: schedule.maxRuns,
        });
      }

      // Check expiration
      if (schedule.expiresAt && Date.now() >= schedule.expiresAt) {
        newStatus = ScheduleStatus.EXPIRED;
        newNextRunAt = undefined;
        this.logger.info('Schedule expired', { scheduleId, expiresAt: schedule.expiresAt });
      }

      // Build update object immutably
      // IMPORTANT: Always include nextRunAt to prevent infinite retrigger when getNextRunTime fails.
      // If newNextRunAt is undefined (e.g., cron parse failure), this clears the old past nextRunAt
      // so the schedule is not returned by findDue on every tick.
      const updates: Partial<Schedule> = {
        runCount: newRunCount,
        lastRunAt: triggeredAt,
        nextRunAt: newNextRunAt,
        ...(newStatus !== undefined ? { status: newStatus } : {}),
      };

      // Persist updates
      const updateResult = await this.scheduleRepo.update(scheduleId, updates);
      if (!updateResult.ok) {
        this.logger.error('Failed to update schedule after trigger', updateResult.error, {
          scheduleId,
        });
        return updateResult;
      }

      // Emit TaskDelegated event for the created task
      await this.eventBus.emit('TaskDelegated', { task });

      // Emit ScheduleExecuted event
      await this.eventBus.emit('ScheduleExecuted', {
        scheduleId,
        taskId: task.id,
        executedAt: triggeredAt,
      });

      this.logger.info('Schedule triggered successfully', {
        scheduleId,
        taskId: task.id,
        runCount: newRunCount,
        nextRunAt: updates.nextRunAt,
        newStatus: updates.status ?? schedule.status,
      });

      return ok(undefined);
    });
  }

  /**
   * Handle schedule cancellation - update status to CANCELLED
   */
  private async handleScheduleCancelled(event: ScheduleCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, reason } = e;

      this.logger.info('Cancelling schedule', { scheduleId, reason });

      const updateResult = await this.scheduleRepo.update(scheduleId, {
        status: ScheduleStatus.CANCELLED,
        nextRunAt: undefined,
      });

      if (!updateResult.ok) {
        this.logger.error('Failed to cancel schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule cancelled', { scheduleId, reason });
      return ok(undefined);
    });
  }

  /**
   * Handle schedule pause - update status to PAUSED
   */
  private async handleSchedulePaused(event: SchedulePausedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId } = e;

      this.logger.info('Pausing schedule', { scheduleId });

      const updateResult = await this.scheduleRepo.update(scheduleId, {
        status: ScheduleStatus.PAUSED,
      });

      if (!updateResult.ok) {
        this.logger.error('Failed to pause schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule paused', { scheduleId });
      return ok(undefined);
    });
  }

  /**
   * Handle schedule resume - update status to ACTIVE, recalculate nextRunAt
   */
  private async handleScheduleResumed(event: ScheduleResumedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId } = e;

      this.logger.info('Resuming schedule', { scheduleId });

      // Fetch current schedule to recalculate nextRunAt
      const scheduleResult = await this.scheduleRepo.findById(scheduleId);
      if (!scheduleResult.ok) {
        return scheduleResult;
      }

      const schedule = scheduleResult.value;
      if (!schedule) {
        return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${scheduleId} not found`, { scheduleId }));
      }

      // Recalculate nextRunAt for CRON schedules
      let nextRunAt = schedule.nextRunAt;
      if (schedule.scheduleType === ScheduleType.CRON && schedule.cronExpression) {
        const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone);
        if (nextResult.ok) {
          nextRunAt = nextResult.value;
        }
      }

      const updateResult = await this.scheduleRepo.update(scheduleId, {
        status: ScheduleStatus.ACTIVE,
        nextRunAt,
      });

      if (!updateResult.ok) {
        this.logger.error('Failed to resume schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule resumed', {
        scheduleId,
        nextRunAt,
        nextRunAtDate: nextRunAt ? new Date(nextRunAt).toISOString() : 'none',
      });
      return ok(undefined);
    });
  }

  /**
   * Handle schedule update - apply partial updates
   */
  private async handleScheduleUpdated(event: ScheduleUpdatedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, update } = e;

      this.logger.info('Updating schedule', { scheduleId, updateFields: Object.keys(update) });

      const updateResult = await this.scheduleRepo.update(scheduleId, update);

      if (!updateResult.ok) {
        this.logger.error('Failed to update schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule updated', { scheduleId });
      return ok(undefined);
    });
  }

  // ============================================================================
  // QUERY EVENT HANDLERS
  // ============================================================================

  /**
   * Handle schedule query - respond with schedule(s)
   */
  private async handleScheduleQuery(event: ScheduleQueryEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, status } = e;
      const correlationId = (e as unknown as { __correlationId?: string }).__correlationId;

      this.logger.debug('Processing schedule query', { scheduleId, status, correlationId });

      let schedules: readonly Schedule[];

      if (scheduleId) {
        const result = await this.scheduleRepo.findById(scheduleId);
        if (!result.ok) {
          this.respondWithError(correlationId, result.error);
          return result;
        }
        schedules = result.value ? [result.value] : [];
      } else if (status) {
        const result = await this.scheduleRepo.findByStatus(status);
        if (!result.ok) {
          this.respondWithError(correlationId, result.error);
          return result;
        }
        schedules = result.value;
      } else {
        const result = await this.scheduleRepo.findAll();
        if (!result.ok) {
          this.respondWithError(correlationId, result.error);
          return result;
        }
        schedules = result.value;
      }

      // Respond to request-reply if correlation ID present
      if (correlationId) {
        (this.eventBus as { respond?: <T>(id: string, value: T) => void }).respond?.(correlationId, schedules);
      }

      // Also emit response event for pub/sub consumers
      await this.eventBus.emit('ScheduleQueryResponse', { schedules });

      return ok(undefined);
    });
  }

  /**
   * Send error response via request-reply correlation if available
   */
  private respondWithError(correlationId: string | undefined, error: Error): void {
    if (correlationId) {
      (this.eventBus as { respondError?: (id: string, err: Error) => void }).respondError?.(correlationId, error);
    }
  }
}

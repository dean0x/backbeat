/**
 * Schedule management service
 * ARCHITECTURE: Extracted from MCP adapter for CLI reuse
 * Pattern: Service layer with DI, Result types, event emission
 * Rationale: Enables schedule operations from MCP, CLI, or any future adapter
 */

import {
  createSchedule,
  MissedRunPolicy,
  Priority,
  Schedule,
  ScheduleCreateRequest,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
} from '../core/domain.js';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { Logger, ScheduleExecution, ScheduleRepository, ScheduleService } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { getNextRunTime, isValidTimezone, validateCronExpression } from '../utils/cron.js';
import { validatePath } from '../utils/validation.js';

/**
 * Map missedRunPolicy string to MissedRunPolicy enum
 * Defaults to SKIP for unrecognized values
 */
export function toMissedRunPolicy(value: string | undefined): MissedRunPolicy {
  switch (value) {
    case 'catchup':
      return MissedRunPolicy.CATCHUP;
    case 'fail':
      return MissedRunPolicy.FAIL;
    default:
      return MissedRunPolicy.SKIP;
  }
}

export class ScheduleManagerService implements ScheduleService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly scheduleRepository: ScheduleRepository,
  ) {
    this.logger.debug('ScheduleManagerService initialized');
  }

  async createSchedule(request: ScheduleCreateRequest): Promise<Result<Schedule>> {
    // Validate schedule type requirements
    if (request.scheduleType === ScheduleType.CRON && !request.cronExpression) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'cronExpression is required for cron schedules', {
          scheduleType: request.scheduleType,
        }),
      );
    }
    if (request.scheduleType === ScheduleType.ONE_TIME && !request.scheduledAt) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'scheduledAt is required for one-time schedules', {
          scheduleType: request.scheduleType,
        }),
      );
    }

    // Validate cron expression
    if (request.cronExpression) {
      const cronResult = validateCronExpression(request.cronExpression);
      if (!cronResult.ok) {
        return cronResult;
      }
    }

    // Validate timezone
    const tz = request.timezone ?? 'UTC';
    if (!isValidTimezone(tz)) {
      return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Invalid timezone: ${tz}`, { timezone: tz }));
    }

    // Parse scheduledAt if provided
    let scheduledAtMs: number | undefined;
    if (request.scheduledAt) {
      scheduledAtMs = Date.parse(request.scheduledAt);
      if (isNaN(scheduledAtMs)) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, `Invalid scheduledAt datetime: ${request.scheduledAt}`, {
            scheduledAt: request.scheduledAt,
          }),
        );
      }
      if (scheduledAtMs <= Date.now()) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, 'scheduledAt must be in the future', {
            scheduledAt: request.scheduledAt,
          }),
        );
      }
    }

    // Parse expiresAt if provided
    let expiresAtMs: number | undefined;
    if (request.expiresAt) {
      expiresAtMs = Date.parse(request.expiresAt);
      if (isNaN(expiresAtMs)) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, `Invalid expiresAt datetime: ${request.expiresAt}`, {
            expiresAt: request.expiresAt,
          }),
        );
      }
    }

    // Calculate nextRunAt
    let nextRunAt: number;
    if (request.scheduleType === ScheduleType.CRON && request.cronExpression) {
      const nextResult = getNextRunTime(request.cronExpression, tz);
      if (!nextResult.ok) {
        return nextResult;
      }
      nextRunAt = nextResult.value;
    } else {
      if (scheduledAtMs === undefined) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, 'scheduledAt must be provided for one-time schedules', {
            scheduleType: request.scheduleType,
          }),
        );
      }
      nextRunAt = scheduledAtMs;
    }

    // Validate workingDirectory
    let validatedWorkingDirectory: string | undefined;
    if (request.workingDirectory) {
      const pathValidation = validatePath(request.workingDirectory);
      if (!pathValidation.ok) {
        return err(
          new BackbeatError(ErrorCode.INVALID_DIRECTORY, `Invalid working directory: ${pathValidation.error.message}`, {
            workingDirectory: request.workingDirectory,
          }),
        );
      }
      validatedWorkingDirectory = pathValidation.value;
    }

    // Create schedule via domain factory
    const schedule = createSchedule({
      taskTemplate: {
        prompt: request.prompt,
        priority: request.priority,
        workingDirectory: validatedWorkingDirectory,
      },
      scheduleType: request.scheduleType,
      cronExpression: request.cronExpression,
      scheduledAt: scheduledAtMs,
      timezone: tz,
      missedRunPolicy: toMissedRunPolicy(request.missedRunPolicy),
      maxRuns: request.maxRuns,
      expiresAt: expiresAtMs,
      afterScheduleId: request.afterScheduleId,
    });

    this.logger.info('Creating schedule', {
      scheduleId: schedule.id,
      scheduleType: schedule.scheduleType,
      nextRunAt: new Date(nextRunAt).toISOString(),
    });

    // Emit event - ScheduleHandler persists with calculated nextRunAt
    const emitResult = await this.eventBus.emit('ScheduleCreated', { schedule });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleCreated event', emitResult.error, {
        scheduleId: schedule.id,
      });
      return err(emitResult.error);
    }

    return ok(schedule);
  }

  async listSchedules(status?: ScheduleStatus, limit?: number, offset?: number): Promise<Result<readonly Schedule[]>> {
    if (status) {
      return this.scheduleRepository.findByStatus(status, limit, offset);
    }
    return this.scheduleRepository.findAll(limit, offset);
  }

  async getSchedule(
    scheduleId: ScheduleId,
    includeHistory?: boolean,
    historyLimit?: number,
  ): Promise<Result<{ schedule: Schedule; history?: readonly ScheduleExecution[] }>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    const schedule = lookupResult.value;
    let history: readonly ScheduleExecution[] | undefined;

    if (includeHistory) {
      const historyResult = await this.scheduleRepository.getExecutionHistory(scheduleId, historyLimit);
      if (historyResult.ok) {
        history = historyResult.value;
      }
      // Non-fatal: log warning but still return schedule data
      if (!historyResult.ok) {
        this.logger.warn('Failed to fetch execution history', {
          scheduleId,
          error: historyResult.error.message,
        });
      }
    }

    return ok({ schedule, history });
  }

  async cancelSchedule(scheduleId: ScheduleId, reason?: string): Promise<Result<void>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    this.logger.info('Cancelling schedule', { scheduleId, reason });

    const emitResult = await this.eventBus.emit('ScheduleCancelled', {
      scheduleId,
      reason,
    });

    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleCancelled event', emitResult.error, {
        scheduleId,
      });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  async pauseSchedule(scheduleId: ScheduleId): Promise<Result<void>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId, ScheduleStatus.ACTIVE);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    this.logger.info('Pausing schedule', { scheduleId });

    const emitResult = await this.eventBus.emit('SchedulePaused', { scheduleId });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit SchedulePaused event', emitResult.error, {
        scheduleId,
      });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  async resumeSchedule(scheduleId: ScheduleId): Promise<Result<void>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId, ScheduleStatus.PAUSED);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    this.logger.info('Resuming schedule', { scheduleId });

    const emitResult = await this.eventBus.emit('ScheduleResumed', { scheduleId });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleResumed event', emitResult.error, {
        scheduleId,
      });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  /**
   * Fetch a schedule by ID and optionally validate its status
   * Returns Result with the schedule or a typed error
   */
  private async fetchScheduleOrError(
    scheduleId: ScheduleId,
    expectedStatus?: ScheduleStatus,
  ): Promise<Result<Schedule>> {
    const result = await this.scheduleRepository.findById(scheduleId);
    if (!result.ok) {
      return err(
        new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to get schedule: ${result.error.message}`, { scheduleId }),
      );
    }

    if (!result.value) {
      return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${scheduleId} not found`, { scheduleId }));
    }

    if (expectedStatus !== undefined && result.value.status !== expectedStatus) {
      return err(
        new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Schedule ${scheduleId} is not ${expectedStatus} (status: ${result.value.status})`,
          { scheduleId, expectedStatus, actualStatus: result.value.status },
        ),
      );
    }

    return ok(result.value);
  }
}

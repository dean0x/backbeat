/**
 * Event-driven autoscaling manager
 * Responds to system events and emits scaling decisions
 */

import { BackbeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { SystemResourcesUpdatedEvent, WorkerKilledEvent } from '../core/events/events.js';
import { BaseEventHandler } from '../core/events/handlers.js';
import { Logger, ResourceMonitor, TaskQueue, WorkerPool } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';

export class AutoscalingManager extends BaseEventHandler {
  private running = false;

  constructor(
    private readonly queue: TaskQueue,
    private readonly workers: WorkerPool,
    private readonly monitor: ResourceMonitor,
    private readonly eventBus: EventBus,
    logger: Logger,
  ) {
    super(logger, 'AutoscalingManager');
  }

  /**
   * Set up event subscriptions
   */
  async setup(): Promise<Result<void>> {
    // Subscribe to events that trigger scaling decisions
    // NOTE: We don't subscribe to TaskQueued - that's WorkerHandler's responsibility
    const subscriptions = [
      this.eventBus.subscribe('WorkerKilled', this.handleWorkerKilled.bind(this)),
      this.eventBus.subscribe('SystemResourcesUpdated', this.handleResourcesUpdated.bind(this)),
    ];

    // Check if any subscription failed
    for (const result of subscriptions) {
      if (!result.ok) {
        return result;
      }
    }

    this.logger.info('Event-driven AutoscalingManager initialized');
    return ok(undefined);
  }

  /**
   * Start the autoscaling manager
   */
  start(): void {
    if (this.running) {
      this.logger.warn('Autoscaling already running');
      return;
    }

    this.running = true;
    this.logger.info('Event-driven autoscaling started');
  }

  /**
   * Stop the autoscaling manager
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.logger.info('Event-driven autoscaling stopped');
  }

  /**
   * Handle worker killed events - check if we need to scale up for remaining queue
   */
  private async handleWorkerKilled(event: WorkerKilledEvent): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.debug('Worker killed, checking for scaling opportunity', {
      workerId: event.workerId,
      taskId: event.taskId,
      eventId: event.eventId,
    });

    // Small delay to let the queue handler process any completed tasks
    setTimeout(() => this.checkScaling(), 100);
  }

  /**
   * Handle system resource updates - check if resources now allow scaling
   */
  private async handleResourcesUpdated(event: SystemResourcesUpdatedEvent): Promise<void> {
    if (!this.running) {
      return;
    }

    // Only check scaling if resources look favorable
    const { cpuPercent, memoryUsed } = event;
    if (cpuPercent < 70) {
      // Good CPU availability
      this.logger.debug('Resources favorable for scaling', {
        cpuPercent,
        memoryUsed,
        eventId: event.eventId,
      });

      await this.checkScaling();
    }
  }

  /**
   * Core scaling decision logic
   */
  private async checkScaling(): Promise<void> {
    try {
      // Get current state
      const queueSize = this.queue.size();
      const workerCount = this.workers.getWorkerCount();

      this.logger.debug('Scaling check', { queueSize, workerCount });

      // If queue is empty, nothing to do
      if (queueSize === 0) {
        return;
      }

      // If we already have enough workers, don't over-provision
      if (workerCount >= queueSize) {
        this.logger.debug('Sufficient workers for queue size', { workerCount, queueSize });
        return;
      }

      // Check if we can spawn more workers
      const canSpawnResult = await this.monitor.canSpawnWorker();

      if (!canSpawnResult.ok) {
        this.logger.error('Failed to check resources for scaling', canSpawnResult.error);
        return;
      }

      if (!canSpawnResult.value) {
        // Can't spawn, log resource status
        await this.logResourceConstraints();
        return;
      }

      // Get next task to spawn worker for
      const peekResult = this.queue.peek();

      if (!peekResult.ok || !peekResult.value) {
        this.logger.debug('No task available in queue for scaling');
        return;
      }

      const task = peekResult.value;

      // Log that we would scale but WorkerHandler handles actual spawning
      this.logger.info('Scaling opportunity detected', {
        queueSize,
        currentWorkers: workerCount,
        taskId: task.id,
        reason: 'Resources available, WorkerHandler should spawn worker',
      });
    } catch (error) {
      this.logger.error('Scaling check failed', error as Error);
    }
  }

  /**
   * Log why we can't scale up
   */
  private async logResourceConstraints(): Promise<void> {
    const resourcesResult = await this.monitor.getResources();

    if (resourcesResult.ok) {
      const resources = resourcesResult.value;
      const thresholds = this.monitor.getThresholds();

      this.logger.debug('Cannot scale - resource constraints', {
        cpuUsage: resources.cpuUsage,
        cpuThreshold: thresholds.maxCpuPercent,
        availableMemory: resources.availableMemory,
        memoryReserve: thresholds.minMemoryBytes,
        workerCount: resources.workerCount,
      });
    }
  }

  /**
   * Get current autoscaling status
   */
  async getStatus(): Promise<{
    running: boolean;
    queueSize: number;
    workerCount: number;
    canSpawn: boolean;
    resources?: {
      cpuUsage: number;
      availableMemory: number;
    };
  }> {
    const queueSize = this.queue.size();
    const workerCount = this.workers.getWorkerCount();

    const canSpawnResult = await this.monitor.canSpawnWorker();
    const canSpawn = canSpawnResult.ok && canSpawnResult.value;

    const resourcesResult = await this.monitor.getResources();
    const resources = resourcesResult.ok
      ? {
          cpuUsage: resourcesResult.value.cpuUsage,
          availableMemory: resourcesResult.value.availableMemory,
        }
      : undefined;

    return {
      running: this.running,
      queueSize,
      workerCount,
      canSpawn,
      resources,
    };
  }
}

/**
 * Autoscaling policy for more sophisticated scaling decisions
 */
export interface AutoscalingPolicy {
  shouldScaleUp(queueSize: number, workerCount: number, cpuUsage: number, memoryAvailable: number): boolean;

  shouldScaleDown(queueSize: number, workerCount: number, cpuUsage: number, memoryAvailable: number): boolean;

  getTargetWorkerCount(queueSize: number, currentWorkers: number): number;
}

/**
 * Default autoscaling policy
 */
export class DefaultAutoscalingPolicy implements AutoscalingPolicy {
  constructor(
    private readonly maxCpuPercent = 80,
    private readonly minMemoryBytes = 1_000_000_000,
    private readonly maxWorkersPerTask = 1,
  ) {}

  shouldScaleUp(queueSize: number, workerCount: number, cpuUsage: number, memoryAvailable: number): boolean {
    // Don't scale if no tasks in queue
    if (queueSize === 0) {
      return false;
    }

    // Don't scale if resources are constrained
    if (cpuUsage >= this.maxCpuPercent) {
      return false;
    }

    if (memoryAvailable <= this.minMemoryBytes) {
      return false;
    }

    // Scale if we have fewer workers than tasks
    return workerCount < queueSize;
  }

  shouldScaleDown(queueSize: number, workerCount: number, cpuUsage: number, memoryAvailable: number): boolean {
    // For now, we don't scale down - workers terminate when done
    // Could implement idle worker termination in the future
    return false;
  }

  getTargetWorkerCount(queueSize: number, currentWorkers: number): number {
    // Simple policy: one worker per task
    return Math.min(queueSize, currentWorkers + 1);
  }
}

/**
 * Aggressive autoscaling policy for maximum throughput
 */
export class AggressiveAutoscalingPolicy implements AutoscalingPolicy {
  shouldScaleUp(queueSize: number, workerCount: number, cpuUsage: number, memoryAvailable: number): boolean {
    // Scale up as long as we have any tasks and any resources
    return queueSize > 0 && cpuUsage < 95 && memoryAvailable > 500_000_000;
  }

  shouldScaleDown(queueSize: number, workerCount: number, cpuUsage: number, memoryAvailable: number): boolean {
    return false;
  }

  getTargetWorkerCount(queueSize: number, currentWorkers: number): number {
    // Try to spawn multiple workers at once
    return currentWorkers + Math.min(queueSize, 5);
  }
}

/**
 * Unit tests for AutoscalingManager, DefaultAutoscalingPolicy, and AggressiveAutoscalingPolicy
 *
 * ARCHITECTURE: Tests behavior via event-driven interactions, not private method internals.
 * Uses vi.fn() mocks for dependencies since we need fine-grained control over return values
 * and call assertions without the overhead of full TestEventBus event routing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskId, WorkerId } from '../../../src/core/domain';
import { BackbeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type { SystemResourcesUpdatedEvent, WorkerKilledEvent } from '../../../src/core/events/events';
import type { Logger, ResourceMonitor, TaskQueue, WorkerPool } from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import {
  AggressiveAutoscalingPolicy,
  AutoscalingManager,
  DefaultAutoscalingPolicy,
} from '../../../src/services/autoscaling-manager';
import { TaskFactory } from '../../fixtures/factories';
import { createMockLogger } from '../../fixtures/mocks';

// -- Mock factories --

const createMockQueue = (): TaskQueue =>
  ({
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    peek: vi.fn().mockReturnValue(ok(null)),
    remove: vi.fn(),
    getAll: vi.fn(),
    contains: vi.fn(),
    size: vi.fn().mockReturnValue(0),
    clear: vi.fn(),
    isEmpty: vi.fn(),
  }) as unknown as TaskQueue;

const createMockWorkerPool = (): WorkerPool =>
  ({
    spawn: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    getWorker: vi.fn(),
    getWorkers: vi.fn(),
    getWorkerCount: vi.fn().mockReturnValue(0),
    getWorkerForTask: vi.fn(),
  }) as unknown as WorkerPool;

const createMockMonitor = (): ResourceMonitor =>
  ({
    getResources: vi.fn().mockResolvedValue(
      ok({
        cpuUsage: 50,
        availableMemory: 4_000_000_000,
        totalMemory: 8_000_000_000,
        loadAverage: [1.0, 1.0, 1.0] as const,
        workerCount: 0,
      }),
    ),
    canSpawnWorker: vi.fn().mockResolvedValue(ok(true)),
    getThresholds: vi.fn().mockReturnValue({
      maxCpuPercent: 80,
      minMemoryBytes: 1_000_000_000,
    }),
    incrementWorkerCount: vi.fn(),
    decrementWorkerCount: vi.fn(),
    recordSpawn: vi.fn(),
  }) as unknown as ResourceMonitor;

const createTestEventBus = (): EventBus =>
  ({
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    request: vi.fn(),
    subscribe: vi.fn().mockReturnValue(ok('sub-1')),
    unsubscribe: vi.fn(),
    subscribeAll: vi.fn(),
    unsubscribeAll: vi.fn(),
    dispose: vi.fn(),
  }) as unknown as EventBus;

// -- Test suites --

describe('AutoscalingManager', () => {
  let manager: AutoscalingManager;
  let queue: TaskQueue;
  let workers: WorkerPool;
  let monitor: ResourceMonitor;
  let eventBus: EventBus;
  let logger: Logger;

  beforeEach(() => {
    queue = createMockQueue();
    workers = createMockWorkerPool();
    monitor = createMockMonitor();
    eventBus = createTestEventBus();
    logger = createMockLogger();
    manager = new AutoscalingManager(queue, workers, monitor, eventBus, logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setup()', () => {
    it('should subscribe to WorkerKilled and SystemResourcesUpdated events', async () => {
      const result = await manager.setup();

      expect(result.ok).toBe(true);
      expect(eventBus.subscribe).toHaveBeenCalledTimes(2);
      expect(eventBus.subscribe).toHaveBeenCalledWith('WorkerKilled', expect.any(Function));
      expect(eventBus.subscribe).toHaveBeenCalledWith('SystemResourcesUpdated', expect.any(Function));
    });

    it('should return error if any subscription fails', async () => {
      const subscribeError = new BackbeatError(ErrorCode.RESOURCE_LIMIT_EXCEEDED, 'Max subscriptions reached');
      vi.mocked(eventBus.subscribe).mockReturnValueOnce(ok('sub-1')).mockReturnValueOnce(err(subscribeError));

      const result = await manager.setup();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(subscribeError);
      }
    });

    it('should log initialization on success', async () => {
      await manager.setup();

      expect(logger.info).toHaveBeenCalledWith('Event-driven AutoscalingManager initialized');
    });
  });

  describe('start()', () => {
    it('should set the running flag', async () => {
      manager.start();

      const status = await manager.getStatus();
      expect(status.running).toBe(true);
    });

    it('should log a warning when called twice', () => {
      manager.start();
      manager.start();

      expect(logger.warn).toHaveBeenCalledWith('Autoscaling already running');
    });

    it('should log info on first start', () => {
      manager.start();

      expect(logger.info).toHaveBeenCalledWith('Event-driven autoscaling started');
    });
  });

  describe('stop()', () => {
    it('should clear the running flag', async () => {
      manager.start();
      manager.stop();

      const status = await manager.getStatus();
      expect(status.running).toBe(false);
    });

    it('should be a no-op when not running', () => {
      manager.stop();

      // Should not log the "stopped" message when it was never running
      expect(logger.info).not.toHaveBeenCalledWith('Event-driven autoscaling stopped');
    });

    it('should log info when stopping from running state', () => {
      manager.start();
      manager.stop();

      expect(logger.info).toHaveBeenCalledWith('Event-driven autoscaling stopped');
    });
  });

  describe('event handling when not running', () => {
    it('should ignore WorkerKilled events when not running', async () => {
      await manager.setup();

      // Extract the registered WorkerKilled handler
      const workerKilledHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'WorkerKilled')?.[1] as (event: WorkerKilledEvent) => Promise<void>;

      expect(workerKilledHandler).toBeDefined();

      // Manager is not started, so handler should return early
      await workerKilledHandler({
        type: 'WorkerKilled',
        eventId: 'evt-1',
        timestamp: Date.now(),
        source: 'test',
        workerId: WorkerId('worker-1'),
        taskId: TaskId('task-1'),
      });

      // queue.size() should not be called since we returned early
      expect(queue.size).not.toHaveBeenCalled();
    });

    it('should ignore SystemResourcesUpdated events when not running', async () => {
      await manager.setup();

      const resourcesHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'SystemResourcesUpdated')?.[1] as (
        event: SystemResourcesUpdatedEvent,
      ) => Promise<void>;

      expect(resourcesHandler).toBeDefined();

      await resourcesHandler({
        type: 'SystemResourcesUpdated',
        eventId: 'evt-2',
        timestamp: Date.now(),
        source: 'test',
        cpuPercent: 30,
        memoryUsed: 2_000_000_000,
        workerCount: 0,
      });

      // queue.size() should not be called since we returned early
      expect(queue.size).not.toHaveBeenCalled();
    });
  });

  describe('WorkerKilled event handling', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      await manager.setup();
      manager.start();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should trigger checkScaling after 100ms debounce delay', async () => {
      const workerKilledHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'WorkerKilled')?.[1] as (event: WorkerKilledEvent) => Promise<void>;

      // Set up queue with tasks and fewer workers
      vi.mocked(queue.size).mockReturnValue(2);
      vi.mocked(workers.getWorkerCount).mockReturnValue(0);

      const task = new TaskFactory().withPrompt('queued task').build();
      vi.mocked(queue.peek).mockReturnValue(ok(task));

      await workerKilledHandler({
        type: 'WorkerKilled',
        eventId: 'evt-1',
        timestamp: Date.now(),
        source: 'test',
        workerId: WorkerId('worker-1'),
        taskId: TaskId('task-1'),
      });

      // Before timeout: checkScaling should not have run
      expect(queue.size).not.toHaveBeenCalled();

      // Advance past the 100ms delay
      vi.advanceTimersByTime(100);

      // Allow the setTimeout callback to execute and the async checkScaling to resolve
      await vi.runAllTimersAsync();

      // After timeout: checkScaling should have run
      expect(queue.size).toHaveBeenCalled();
    });
  });

  describe('SystemResourcesUpdated event handling', () => {
    beforeEach(async () => {
      await manager.setup();
      manager.start();
    });

    it('should trigger checkScaling when cpuPercent < 70', async () => {
      const resourcesHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'SystemResourcesUpdated')?.[1] as (
        event: SystemResourcesUpdatedEvent,
      ) => Promise<void>;

      vi.mocked(queue.size).mockReturnValue(0);

      await resourcesHandler({
        type: 'SystemResourcesUpdated',
        eventId: 'evt-1',
        timestamp: Date.now(),
        source: 'test',
        cpuPercent: 50,
        memoryUsed: 2_000_000_000,
        workerCount: 0,
      });

      // checkScaling was called, so queue.size() should have been invoked
      expect(queue.size).toHaveBeenCalled();
    });

    it('should NOT trigger checkScaling when cpuPercent >= 70', async () => {
      const resourcesHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'SystemResourcesUpdated')?.[1] as (
        event: SystemResourcesUpdatedEvent,
      ) => Promise<void>;

      await resourcesHandler({
        type: 'SystemResourcesUpdated',
        eventId: 'evt-2',
        timestamp: Date.now(),
        source: 'test',
        cpuPercent: 70,
        memoryUsed: 4_000_000_000,
        workerCount: 2,
      });

      expect(queue.size).not.toHaveBeenCalled();
    });

    it('should NOT trigger checkScaling when cpuPercent is above 70', async () => {
      const resourcesHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'SystemResourcesUpdated')?.[1] as (
        event: SystemResourcesUpdatedEvent,
      ) => Promise<void>;

      await resourcesHandler({
        type: 'SystemResourcesUpdated',
        eventId: 'evt-3',
        timestamp: Date.now(),
        source: 'test',
        cpuPercent: 85,
        memoryUsed: 5_000_000_000,
        workerCount: 3,
      });

      expect(queue.size).not.toHaveBeenCalled();
    });
  });

  describe('checkScaling behavior (tested via SystemResourcesUpdated with favorable CPU)', () => {
    let triggerCheckScaling: () => Promise<void>;

    beforeEach(async () => {
      await manager.setup();
      manager.start();

      const resourcesHandler = vi
        .mocked(eventBus.subscribe)
        .mock.calls.find((call) => call[0] === 'SystemResourcesUpdated')?.[1] as (
        event: SystemResourcesUpdatedEvent,
      ) => Promise<void>;

      // Helper to trigger checkScaling via a favorable resource update
      triggerCheckScaling = async () => {
        await resourcesHandler({
          type: 'SystemResourcesUpdated',
          eventId: `evt-${Date.now()}`,
          timestamp: Date.now(),
          source: 'test',
          cpuPercent: 30,
          memoryUsed: 2_000_000_000,
          workerCount: 0,
        });
      };
    });

    it('should return early when queue is empty', async () => {
      vi.mocked(queue.size).mockReturnValue(0);

      await triggerCheckScaling();

      expect(queue.size).toHaveBeenCalled();
      // Should not check canSpawnWorker when queue is empty
      expect(monitor.canSpawnWorker).not.toHaveBeenCalled();
    });

    it('should return early when workers >= queueSize', async () => {
      vi.mocked(queue.size).mockReturnValue(2);
      vi.mocked(workers.getWorkerCount).mockReturnValue(3);

      await triggerCheckScaling();

      expect(logger.debug).toHaveBeenCalledWith('Sufficient workers for queue size', {
        workerCount: 3,
        queueSize: 2,
      });
      expect(monitor.canSpawnWorker).not.toHaveBeenCalled();
    });

    it('should log resource constraints when canSpawnWorker returns false', async () => {
      vi.mocked(queue.size).mockReturnValue(3);
      vi.mocked(workers.getWorkerCount).mockReturnValue(1);
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(ok(false));

      await triggerCheckScaling();

      // Should call getResources and getThresholds to log constraints
      expect(monitor.getResources).toHaveBeenCalled();
      expect(monitor.getThresholds).toHaveBeenCalled();
    });

    it('should log error when canSpawnWorker returns an error Result', async () => {
      vi.mocked(queue.size).mockReturnValue(2);
      vi.mocked(workers.getWorkerCount).mockReturnValue(0);
      const monitorError = new BackbeatError(ErrorCode.RESOURCE_MONITORING_FAILED, 'Cannot read resources');
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(err(monitorError));

      await triggerCheckScaling();

      expect(logger.error).toHaveBeenCalledWith('Failed to check resources for scaling', monitorError);
    });

    it('should log scaling opportunity when resources available and queue has tasks', async () => {
      const task = new TaskFactory().withPrompt('scaling test task').build();
      vi.mocked(queue.size).mockReturnValue(3);
      vi.mocked(workers.getWorkerCount).mockReturnValue(1);
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(ok(true));
      vi.mocked(queue.peek).mockReturnValue(ok(task));

      await triggerCheckScaling();

      expect(logger.info).toHaveBeenCalledWith('Scaling opportunity detected', {
        queueSize: 3,
        currentWorkers: 1,
        taskId: task.id,
        reason: 'Resources available, WorkerHandler should spawn worker',
      });
    });

    it('should log no-task-available when peek returns null', async () => {
      vi.mocked(queue.size).mockReturnValue(2);
      vi.mocked(workers.getWorkerCount).mockReturnValue(0);
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(ok(true));
      vi.mocked(queue.peek).mockReturnValue(ok(null));

      await triggerCheckScaling();

      expect(logger.debug).toHaveBeenCalledWith('No task available in queue for scaling');
    });

    it('should log no-task-available when peek returns an error', async () => {
      vi.mocked(queue.size).mockReturnValue(2);
      vi.mocked(workers.getWorkerCount).mockReturnValue(0);
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(ok(true));
      vi.mocked(queue.peek).mockReturnValue(err(new BackbeatError(ErrorCode.QUEUE_EMPTY, 'Queue error')));

      await triggerCheckScaling();

      expect(logger.debug).toHaveBeenCalledWith('No task available in queue for scaling');
    });
  });

  describe('getStatus()', () => {
    it('should return correct status when not running', async () => {
      vi.mocked(queue.size).mockReturnValue(5);
      vi.mocked(workers.getWorkerCount).mockReturnValue(2);
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(ok(true));

      const status = await manager.getStatus();

      expect(status.running).toBe(false);
      expect(status.queueSize).toBe(5);
      expect(status.workerCount).toBe(2);
      expect(status.canSpawn).toBe(true);
    });

    it('should return correct status when running', async () => {
      manager.start();
      vi.mocked(queue.size).mockReturnValue(3);
      vi.mocked(workers.getWorkerCount).mockReturnValue(1);
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(ok(false));

      const status = await manager.getStatus();

      expect(status.running).toBe(true);
      expect(status.queueSize).toBe(3);
      expect(status.workerCount).toBe(1);
      expect(status.canSpawn).toBe(false);
    });

    it('should include resource info when getResources succeeds', async () => {
      vi.mocked(monitor.getResources).mockResolvedValue(
        ok({
          cpuUsage: 45,
          availableMemory: 6_000_000_000,
          totalMemory: 8_000_000_000,
          loadAverage: [1.0, 1.0, 1.0] as const,
          workerCount: 2,
        }),
      );

      const status = await manager.getStatus();

      expect(status.resources).toEqual({
        cpuUsage: 45,
        availableMemory: 6_000_000_000,
      });
    });

    it('should omit resource info when getResources fails', async () => {
      vi.mocked(monitor.getResources).mockResolvedValue(
        err(new BackbeatError(ErrorCode.RESOURCE_MONITORING_FAILED, 'Cannot read resources')),
      );

      const status = await manager.getStatus();

      expect(status.resources).toBeUndefined();
    });

    it('should set canSpawn to false when canSpawnWorker returns an error', async () => {
      vi.mocked(monitor.canSpawnWorker).mockResolvedValue(
        err(new BackbeatError(ErrorCode.RESOURCE_MONITORING_FAILED, 'Check failed')),
      );

      const status = await manager.getStatus();

      expect(status.canSpawn).toBe(false);
    });
  });
});

describe('DefaultAutoscalingPolicy', () => {
  let policy: DefaultAutoscalingPolicy;

  beforeEach(() => {
    policy = new DefaultAutoscalingPolicy();
  });

  describe('shouldScaleUp()', () => {
    it('should return false when queue is empty', () => {
      expect(policy.shouldScaleUp(0, 0, 30, 4_000_000_000)).toBe(false);
    });

    it('should return false when CPU usage is at threshold (>= 80)', () => {
      expect(policy.shouldScaleUp(5, 1, 80, 4_000_000_000)).toBe(false);
    });

    it('should return false when CPU usage exceeds threshold', () => {
      expect(policy.shouldScaleUp(5, 1, 95, 4_000_000_000)).toBe(false);
    });

    it('should return false when memory is at or below minimum (<=1GB)', () => {
      expect(policy.shouldScaleUp(5, 1, 30, 1_000_000_000)).toBe(false);
    });

    it('should return false when memory is below minimum', () => {
      expect(policy.shouldScaleUp(5, 1, 30, 500_000_000)).toBe(false);
    });

    it('should return false when workers >= queueSize', () => {
      expect(policy.shouldScaleUp(3, 3, 30, 4_000_000_000)).toBe(false);
      expect(policy.shouldScaleUp(2, 5, 30, 4_000_000_000)).toBe(false);
    });

    it('should return true under favorable conditions (queue>0, cpu<80, mem>1GB, workers<queue)', () => {
      expect(policy.shouldScaleUp(5, 2, 50, 4_000_000_000)).toBe(true);
    });

    it('should return true at boundary conditions (just under thresholds)', () => {
      // cpu just under 80, memory just above 1GB, 1 worker for 2 tasks
      expect(policy.shouldScaleUp(2, 1, 79, 1_000_000_001)).toBe(true);
    });
  });

  describe('shouldScaleDown()', () => {
    it('should always return false regardless of inputs', () => {
      expect(policy.shouldScaleDown(0, 5, 10, 8_000_000_000)).toBe(false);
      expect(policy.shouldScaleDown(0, 0, 95, 100_000_000)).toBe(false);
      expect(policy.shouldScaleDown(10, 10, 50, 4_000_000_000)).toBe(false);
    });
  });

  describe('getTargetWorkerCount()', () => {
    it('should return min(queueSize, currentWorkers + 1)', () => {
      // queueSize=5, current=2 => min(5, 3) = 3
      expect(policy.getTargetWorkerCount(5, 2)).toBe(3);
    });

    it('should cap at queueSize when currentWorkers + 1 exceeds it', () => {
      // queueSize=1, current=5 => min(1, 6) = 1
      expect(policy.getTargetWorkerCount(1, 5)).toBe(1);
    });

    it('should return 1 when starting from 0 workers with tasks in queue', () => {
      // queueSize=3, current=0 => min(3, 1) = 1
      expect(policy.getTargetWorkerCount(3, 0)).toBe(1);
    });

    it('should return 0 when queue is empty', () => {
      // queueSize=0, current=2 => min(0, 3) = 0
      expect(policy.getTargetWorkerCount(0, 2)).toBe(0);
    });
  });

  describe('custom thresholds', () => {
    it('should respect custom maxCpuPercent threshold', () => {
      const customPolicy = new DefaultAutoscalingPolicy(60);
      // Should return false at cpu=60 (>= threshold)
      expect(customPolicy.shouldScaleUp(5, 1, 60, 4_000_000_000)).toBe(false);
      // Should return true at cpu=59 (< threshold)
      expect(customPolicy.shouldScaleUp(5, 1, 59, 4_000_000_000)).toBe(true);
    });

    it('should respect custom minMemoryBytes threshold', () => {
      const customPolicy = new DefaultAutoscalingPolicy(80, 2_000_000_000);
      // Should return false at memory=2GB (<= threshold)
      expect(customPolicy.shouldScaleUp(5, 1, 30, 2_000_000_000)).toBe(false);
      // Should return true at memory>2GB
      expect(customPolicy.shouldScaleUp(5, 1, 30, 2_000_000_001)).toBe(true);
    });
  });
});

describe('AggressiveAutoscalingPolicy', () => {
  let policy: AggressiveAutoscalingPolicy;

  beforeEach(() => {
    policy = new AggressiveAutoscalingPolicy();
  });

  describe('shouldScaleUp()', () => {
    it('should return true when queue > 0, cpu < 95, and memory > 500MB', () => {
      expect(policy.shouldScaleUp(3, 2, 90, 1_000_000_000)).toBe(true);
    });

    it('should return false when queue is empty', () => {
      expect(policy.shouldScaleUp(0, 0, 30, 4_000_000_000)).toBe(false);
    });

    it('should return false when cpu >= 95', () => {
      expect(policy.shouldScaleUp(5, 1, 95, 4_000_000_000)).toBe(false);
    });

    it('should return false when memory <= 500MB', () => {
      expect(policy.shouldScaleUp(5, 1, 30, 500_000_000)).toBe(false);
    });

    it('should scale even when workers exceed queue size (unlike Default)', () => {
      // Aggressive policy does not check workers vs queue
      expect(policy.shouldScaleUp(2, 5, 50, 4_000_000_000)).toBe(true);
    });

    it('should return true at boundary conditions (just under thresholds)', () => {
      expect(policy.shouldScaleUp(1, 0, 94, 500_000_001)).toBe(true);
    });
  });

  describe('shouldScaleDown()', () => {
    it('should always return false', () => {
      expect(policy.shouldScaleDown(0, 10, 10, 8_000_000_000)).toBe(false);
      expect(policy.shouldScaleDown(0, 0, 99, 100_000_000)).toBe(false);
    });
  });

  describe('getTargetWorkerCount()', () => {
    it('should return currentWorkers + min(queueSize, 5)', () => {
      // current=2, queue=3 => 2 + min(3, 5) = 5
      expect(policy.getTargetWorkerCount(3, 2)).toBe(5);
    });

    it('should cap the burst at 5 additional workers', () => {
      // current=2, queue=10 => 2 + min(10, 5) = 7
      expect(policy.getTargetWorkerCount(10, 2)).toBe(7);
    });

    it('should add exactly queueSize workers when queue < 5', () => {
      // current=0, queue=2 => 0 + min(2, 5) = 2
      expect(policy.getTargetWorkerCount(2, 0)).toBe(2);
    });

    it('should add 5 workers when queue >= 5', () => {
      // current=0, queue=100 => 0 + min(100, 5) = 5
      expect(policy.getTargetWorkerCount(100, 0)).toBe(5);
    });

    it('should handle zero queue size', () => {
      // current=3, queue=0 => 3 + min(0, 5) = 3
      expect(policy.getTargetWorkerCount(0, 3)).toBe(3);
    });
  });
});

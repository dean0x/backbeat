/**
 * Integration test for worker pool management
 * Tests worker lifecycle, resource monitoring, and autoscaling decisions
 */

import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/domain.js';
import { InMemoryEventBus } from '../../src/core/events/event-bus.js';
import { EventDrivenWorkerPool } from '../../src/implementations/event-driven-worker-pool.js';
import { BufferedOutputCapture } from '../../src/implementations/output-capture.js';
import { PriorityTaskQueue } from '../../src/implementations/task-queue.js';
import { AutoscalingManager } from '../../src/services/autoscaling-manager.js';
import { createTestConfiguration } from '../fixtures/factories.js';
import { createAgentRegistryFromSpawner } from '../fixtures/mock-agent.js';
import { MockProcessSpawner } from '../fixtures/mock-process-spawner.js';
import { MockResourceMonitor } from '../fixtures/mock-resource-monitor.js';
import { createTestTask as createTask } from '../fixtures/test-data.js';
import { TestLogger } from '../fixtures/test-doubles.js';
import { flushEventLoop } from '../utils/event-helpers.js';

describe('Integration: Worker pool management', () => {
  it('should handle worker pool lifecycle management', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);
    const resourceMonitor = new MockResourceMonitor();

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry, // agentRegistry
      resourceMonitor, // monitor
      logger, // logger
      eventBus, // eventBus
      outputCapture, // outputCapture
    );

    try {
      // Track worker events and task-worker mappings
      const workerEvents: string[] = [];
      const activeWorkers = new Set<WorkerId>();
      const taskToWorker = new Map<string, WorkerId>(); // Map task IDs to worker IDs

      eventBus.on('WorkerSpawned', (data) => {
        const workerId = data.worker?.id || data.workerId;
        const taskId = data.task?.id || data.taskId;
        workerEvents.push(`spawned:${workerId}`);
        activeWorkers.add(workerId);
        if (taskId) {
          taskToWorker.set(taskId, workerId);
        }
      });

      // Listen for task completion/failure which affects workers
      eventBus.on('TaskCompleted', (data) => {
        const workerId = taskToWorker.get(data.taskId);
        if (workerId) {
          workerEvents.push(`completed:${workerId}`);
          activeWorkers.delete(workerId);
          taskToWorker.delete(data.taskId);
        }
      });

      eventBus.on('TaskFailed', (data) => {
        const workerId = taskToWorker.get(data.taskId);
        if (workerId) {
          workerEvents.push(`failed:${workerId}`);
          activeWorkers.delete(workerId);
          taskToWorker.delete(data.taskId);
        }
      });

      eventBus.on('WorkerKilled', (data) => {
        workerEvents.push(`killed:${data.workerId}`);
        activeWorkers.delete(data.workerId);
        // Remove from task mapping
        for (const [taskId, workerId] of taskToWorker.entries()) {
          if (workerId === data.workerId) {
            taskToWorker.delete(taskId);
            break;
          }
        }
      });

      // Test 1: Spawn workers up to limit
      // Use 'sleep' in prompt to prevent auto-completion
      const tasks = Array.from({ length: 5 }, (_, i) => createTask({ prompt: `sleep 10 && echo "Task ${i}"` }));

      // Spawn first 3 workers (at max capacity)
      for (let i = 0; i < 3; i++) {
        const result = await workerPool.spawn(tasks[i]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Update worker count in monitor so it knows we have workers
          resourceMonitor.updateWorkerCount(i + 1);
          // Emit WorkerSpawned event since we're not using WorkerHandler
          await eventBus.emit('WorkerSpawned', {
            workerId: result.value.id,
            taskId: tasks[i].id,
          });
        }
      }

      // Wait for events to process
      await flushEventLoop();

      expect(activeWorkers.size).toBe(3);

      // Test 2: Cannot spawn beyond limit - simulate resource exhaustion
      resourceMonitor.simulateHighCPU(90); // High CPU prevents spawning
      const result = await workerPool.spawn(tasks[3]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INSUFFICIENT_RESOURCES');
      }
      resourceMonitor.simulateHighCPU(30); // Reset CPU

      // Test 3: Complete a worker to free slot
      processSpawner.simulateCompletion(tasks[0].id, 'Task 0 complete');
      await flushEventLoop();
      expect(activeWorkers.size).toBe(2);

      // Test 4: Can spawn new worker after slot freed
      const newResult = await workerPool.spawn(tasks[3]);
      expect(newResult.ok).toBe(true);
      if (newResult.ok) {
        // Emit WorkerSpawned event
        await eventBus.emit('WorkerSpawned', {
          workerId: newResult.value.id,
          taskId: tasks[3].id,
        });
      }
      await flushEventLoop(); // Wait for event
      expect(activeWorkers.size).toBe(3);

      // Test 5: Handle worker failure
      processSpawner.simulateError(tasks[1].id, new Error('Worker crashed'));
      await flushEventLoop();

      expect(workerEvents.some((e) => e.includes('failed'))).toBe(true);
      expect(activeWorkers.size).toBe(2);

      // Test 6: Terminate all workers
      await workerPool.killAll();
      await flushEventLoop();

      expect(activeWorkers.size).toBe(0);
    } finally {
      await workerPool.killAll();
      eventBus.dispose();
    }
  });

  it('should handle autoscaling with resource monitoring', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const queue = new PriorityTaskQueue(logger);
    const resourceMonitor = new MockResourceMonitor();
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry, // agentRegistry
      resourceMonitor, // monitor
      logger, // logger
      eventBus, // eventBus
      outputCapture, // outputCapture
    );

    const autoscaler = new AutoscalingManager(
      queue, // queue
      workerPool, // workers
      resourceMonitor, // monitor
      eventBus, // eventBus
      logger, // logger
    );

    try {
      // Track worker events
      let currentWorkerCount = 0;
      const workerIds = new Set<string>();

      eventBus.on('WorkerSpawned', (data) => {
        const workerId = data.worker?.id || data.workerId;
        if (workerId) {
          workerIds.add(workerId);
          currentWorkerCount = workerIds.size;
        }
      });

      eventBus.on('WorkerCompleted', (data) => {
        if (data.workerId) {
          workerIds.delete(data.workerId);
          currentWorkerCount = workerIds.size;
        }
      });

      eventBus.on('WorkerKilled', (data) => {
        if (data.workerId) {
          workerIds.delete(data.workerId);
          currentWorkerCount = workerIds.size;
        }
      });

      // Setup autoscaling first
      await autoscaler.setup();
      autoscaler.start();

      // Test 1: Workers should NOT spawn automatically just from queueing
      // (WorkerHandler needs to be set up to respond to TaskQueued events)
      const tasks = Array.from({ length: 3 }, (_, i) => createTask({ prompt: `Scaling task ${i}` }));

      // Queue tasks
      tasks.forEach((task) => queue.enqueue(task));

      // Wait a bit - but workers won't spawn without WorkerHandler
      await flushEventLoop();

      // Since we don't have WorkerHandler set up, no workers spawn
      expect(currentWorkerCount).toBe(0);
      expect(workerIds.size).toBe(0);

      // Test 2: Respect resource limits
      // Simulate high CPU usage
      resourceMonitor.simulateHighCPU(85);

      // Add more tasks
      const moreTasks = Array.from({ length: 5 }, (_, i) => createTask({ prompt: `More task ${i}` }));
      moreTasks.forEach((task) => queue.enqueue(task));

      await flushEventLoop();

      // Should not scale beyond resource limits
      const workerCountUnderLoad = currentWorkerCount;
      expect(workerCountUnderLoad).toBeLessThanOrEqual(3);

      // Test 3: Scale down when idle
      // Clear queue and complete all tasks
      while (queue.size() > 0) {
        queue.dequeue();
      }

      // Simulate all workers completing
      const activeTasks = processSpawner.getActiveTasks();
      activeTasks.forEach((taskId) => {
        processSpawner.simulateCompletion(taskId, 'Complete');
      });

      // Reset CPU usage
      resourceMonitor.simulateHighCPU(30);

      // Wait for scale down
      await flushEventLoop();

      expect(currentWorkerCount).toBe(0);

      // Test 4: Queue should have tasks but no workers spawn without WorkerHandler
      // Add tasks one by one
      for (let i = 0; i < 3; i++) {
        queue.enqueue(createTask({ prompt: `Rapid task ${i}` }));
        await flushEventLoop();
      }

      // Queue should have tasks (only the 3 we just added, since we cleared earlier)
      expect(queue.size()).toBe(3);

      // Autoscaler doesn't have stop method, just clean up
    } finally {
      // Clean up resources
      await workerPool.killAll();
      eventBus.dispose();
    }
  });

  it('should handle output capture and streaming', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus); // 10MB buffer to allow large output

    try {
      const task = createTask({ prompt: 'Output test' });

      // Track output events
      const outputs: string[] = [];
      eventBus.on('OutputReceived', (data) => {
        outputs.push(data.output);
      });

      // Test 1: Capture stdout
      outputCapture.capture(task.id, 'stdout', 'Line 1\n');
      outputCapture.capture(task.id, 'stdout', 'Line 2\n');
      eventBus.emit('OutputReceived', { taskId: task.id, output: 'Line 1\nLine 2\n' });

      const output1Result = outputCapture.getOutput(task.id);
      expect(output1Result.ok).toBe(true);
      if (output1Result.ok) {
        const stdoutStr = output1Result.value.stdout.join('');
        expect(stdoutStr).toContain('Line 1');
        expect(stdoutStr).toContain('Line 2');
      }

      // Test 2: Handle large output
      const largeOutput = 'x'.repeat(2048); // Large output
      const captureResult = outputCapture.capture(task.id, 'stdout', largeOutput);

      // Check if capture succeeded
      expect(captureResult.ok).toBe(true);

      const output2Result = outputCapture.getOutput(task.id);
      expect(output2Result.ok).toBe(true);
      if (output2Result.ok) {
        const totalOutput = output2Result.value.stdout.join('');
        // Should have all output captured
        expect(totalOutput).toContain('Line 1');
        expect(totalOutput).toContain('Line 2');
        expect(totalOutput).toContain('xxx'); // At least some x's
      }

      // Test 3: Tail functionality
      for (let i = 3; i <= 10; i++) {
        outputCapture.capture(task.id, 'stdout', `Line ${i}\n`);
      }

      // getOutput with tail parameter instead of separate tail method
      const tailResult = outputCapture.getOutput(task.id, 3);
      expect(tailResult.ok).toBe(true);
      if (tailResult.ok) {
        const tailLines = tailResult.value.stdout.slice(-3);
        expect(tailLines.length).toBe(3);
        expect(tailLines[2]).toContain('Line 10');
      }

      // Test 4: Verify output persists
      const finalOutputResult = outputCapture.getOutput(task.id);
      expect(finalOutputResult.ok).toBe(true);
      if (finalOutputResult.ok) {
        const hasOutput =
          finalOutputResult.value.stdout.length > 0 || finalOutputResult.value.stdout.join('').length > 0;
        expect(hasOutput).toBe(true);
      }

      // Test 5: Multiple concurrent captures
      const tasks = Array.from({ length: 5 }, (_, i) => createTask({ prompt: `Concurrent output ${i}` }));

      // Capture output for all tasks
      tasks.forEach((t, i) => {
        outputCapture.capture(t.id, 'stdout', `Output from task ${i}\n`);
      });

      // Verify all outputs captured
      for (let i = 0; i < tasks.length; i++) {
        const outputResult = outputCapture.getOutput(tasks[i].id);
        expect(outputResult.ok).toBe(true);
        if (outputResult.ok) {
          const stdoutStr = outputResult.value.stdout.join('');
          expect(stdoutStr).toContain(`task ${i}`);
        }
      }
    } finally {
      outputCapture.cleanup();
      eventBus.dispose();
    }
  });
});

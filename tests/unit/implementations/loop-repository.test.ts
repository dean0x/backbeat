/**
 * Unit tests for SQLiteLoopRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoop,
  createSchedule,
  createTask,
  type Loop,
  LoopId,
  type LoopIteration,
  LoopStatus,
  LoopStrategy,
  MissedRunPolicy,
  OptimizeDirection,
  ScheduleType,
  TaskId,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { SQLiteScheduleRepository } from '../../../src/implementations/schedule-repository.js';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository.js';

describe('SQLiteLoopRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLiteLoopRepository;
  let taskRepo: SQLiteTaskRepository;
  let scheduleRepo: SQLiteScheduleRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteLoopRepository(db);
    taskRepo = new SQLiteTaskRepository(db);
    scheduleRepo = new SQLiteScheduleRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a loop with sensible defaults
  function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
    return createLoop(
      {
        prompt: 'Run the tests',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'test -f /tmp/done',
        maxIterations: 10,
        maxConsecutiveFailures: 3,
        cooldownMs: 0,
        freshContext: true,
        evalTimeout: 60000,
        ...overrides,
      },
      '/tmp',
    );
  }

  // Helper: create a task in the task repo so FK constraint is satisfied
  async function createTaskInRepo(taskId: TaskId): Promise<void> {
    const task = { ...createTask({ prompt: 'test', workingDirectory: '/tmp' }), id: taskId };
    await taskRepo.save(task);
  }

  // Helper to create a loop iteration (must call createTaskInRepo first for taskId)
  function createTestIteration(
    loopId: LoopId,
    iterationNumber: number,
    overrides: Partial<LoopIteration> = {},
  ): LoopIteration {
    return {
      id: 0, // Auto-increment
      loopId,
      iterationNumber,
      taskId: TaskId(`task-iter-${iterationNumber}`),
      status: 'running',
      startedAt: Date.now(),
      ...overrides,
    };
  }

  // Helper: create task in repo, then record iteration
  async function saveIteration(
    loopId: LoopId,
    iterationNumber: number,
    overrides: Partial<LoopIteration> = {},
  ): Promise<void> {
    const iteration = createTestIteration(loopId, iterationNumber, overrides);
    await createTaskInRepo(iteration.taskId);
    await repo.recordIteration(iteration);
  }

  describe('save() and findById()', () => {
    it('should save and retrieve a loop by ID', async () => {
      const loop = createTestLoop();
      const saveResult = await repo.save(loop);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value).toBeDefined();
      expect(findResult.value!.id).toBe(loop.id);
      expect(findResult.value!.strategy).toBe(LoopStrategy.RETRY);
      expect(findResult.value!.exitCondition).toBe('test -f /tmp/done');
      expect(findResult.value!.maxIterations).toBe(10);
      expect(findResult.value!.maxConsecutiveFailures).toBe(3);
      expect(findResult.value!.status).toBe(LoopStatus.RUNNING);
      expect(findResult.value!.currentIteration).toBe(0);
      expect(findResult.value!.consecutiveFailures).toBe(0);
    });

    it('should persist task_template JSON correctly', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.taskTemplate.prompt).toBe('Run the tests');
      expect(findResult.value!.taskTemplate.workingDirectory).toBe('/tmp');
    });

    it('should return undefined when loop not found', async () => {
      const result = await repo.findById(LoopId('non-existent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeNull();
    });

    it('should handle optimize strategy with evalDirection', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MINIMIZE,
      });

      await repo.save(loop);
      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.strategy).toBe(LoopStrategy.OPTIMIZE);
      expect(findResult.value!.evalDirection).toBe(OptimizeDirection.MINIMIZE);
    });
  });

  describe('update()', () => {
    it('should update loop status', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const updated = { ...loop, status: LoopStatus.COMPLETED, completedAt: Date.now(), updatedAt: Date.now() };
      const updateResult = await repo.update(updated);
      expect(updateResult.ok).toBe(true);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(LoopStatus.COMPLETED);
      expect(findResult.value!.completedAt).toBeDefined();
    });

    it('should update currentIteration and consecutiveFailures', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const updated = { ...loop, currentIteration: 5, consecutiveFailures: 2, updatedAt: Date.now() };
      await repo.update(updated);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.currentIteration).toBe(5);
      expect(findResult.value!.consecutiveFailures).toBe(2);
    });

    it('should update bestScore and bestIterationId', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      await repo.save(loop);

      const updated = { ...loop, bestScore: 0.95, bestIterationId: 3, updatedAt: Date.now() };
      await repo.update(updated);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.bestScore).toBe(0.95);
      expect(findResult.value!.bestIterationId).toBe(3);
    });
  });

  describe('findByStatus()', () => {
    it('should return loops with matching status', async () => {
      const running = createTestLoop();
      const completed = createTestLoop();
      await repo.save(running);
      await repo.save(completed);

      // Complete the second loop
      const updatedCompleted = {
        ...completed,
        status: LoopStatus.COMPLETED,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await repo.update(updatedCompleted);

      const result = await repo.findByStatus(LoopStatus.RUNNING);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(running.id);
    });

    it('should return empty array when no matching loops', async () => {
      await repo.save(createTestLoop());

      const result = await repo.findByStatus(LoopStatus.CANCELLED);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it('should respect limit and offset for pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.save(createTestLoop());
      }

      const result = await repo.findByStatus(LoopStatus.RUNNING, 2, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
    });
  });

  describe('findAll()', () => {
    it('should return all loops', async () => {
      await repo.save(createTestLoop());
      await repo.save(createTestLoop());
      await repo.save(createTestLoop());

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
    });

    it('should return empty array when no loops exist', async () => {
      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it('should respect custom limit and offset', async () => {
      for (let i = 0; i < 10; i++) {
        await repo.save(createTestLoop());
      }

      const result = await repo.findAll(3, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
    });

    it('should apply default limit of 100', async () => {
      for (let i = 0; i < 105; i++) {
        await repo.save(createTestLoop());
      }

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(100);
    });
  });

  describe('count()', () => {
    it('should return total loop count', async () => {
      await repo.save(createTestLoop());
      await repo.save(createTestLoop());

      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe(2);
    });

    it('should return 0 for empty repository', async () => {
      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe(0);
    });
  });

  describe('delete()', () => {
    it('should delete a loop', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const deleteResult = await repo.delete(loop.id);
      expect(deleteResult.ok).toBe(true);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value).toBeNull();
    });

    it('should cascade delete iterations when loop is deleted', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      // Record iterations (create tasks first for FK constraint)
      await saveIteration(loop.id, 1);
      await saveIteration(loop.id, 2);

      // Verify iterations exist
      const itersBefore = await repo.getIterations(loop.id);
      expect(itersBefore.ok).toBe(true);
      if (!itersBefore.ok) return;
      expect(itersBefore.value).toHaveLength(2);

      // Delete loop
      await repo.delete(loop.id);

      // Iterations should be cascade-deleted
      const itersAfter = await repo.getIterations(loop.id);
      expect(itersAfter.ok).toBe(true);
      if (!itersAfter.ok) return;
      expect(itersAfter.value).toHaveLength(0);
    });

    it('should succeed even when loop does not exist', async () => {
      const result = await repo.delete(LoopId('non-existent'));
      expect(result.ok).toBe(true);
    });
  });

  describe('recordIteration() and getIterations()', () => {
    it('should record and retrieve an iteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);

      const getResult = await repo.getIterations(loop.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value).toHaveLength(1);
      expect(getResult.value[0].loopId).toBe(loop.id);
      expect(getResult.value[0].iterationNumber).toBe(1);
      expect(getResult.value[0].status).toBe('running');
    });

    it('should return iterations in DESC order by iteration_number', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);
      await saveIteration(loop.id, 2);
      await saveIteration(loop.id, 3);

      const result = await repo.getIterations(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
      expect(result.value[0].iterationNumber).toBe(3);
      expect(result.value[1].iterationNumber).toBe(2);
      expect(result.value[2].iterationNumber).toBe(1);
    });

    it('should respect limit for getIterations', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      for (let i = 1; i <= 5; i++) {
        await saveIteration(loop.id, i);
      }

      const result = await repo.getIterations(loop.id, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      // Should get the latest 2 (iteration 5 and 4)
      expect(result.value[0].iterationNumber).toBe(5);
      expect(result.value[1].iterationNumber).toBe(4);
    });
  });

  describe('findIterationByTaskId()', () => {
    it('should find iteration by its task ID', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-lookup-test');
      await createTaskInRepo(taskId);
      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId }));

      const result = await repo.findIterationByTaskId(taskId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeDefined();
      expect(result.value!.taskId).toBe(taskId);
      expect(result.value!.iterationNumber).toBe(1);
    });

    it('should return undefined when task ID not found', async () => {
      const result = await repo.findIterationByTaskId(TaskId('no-such-task'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeNull();
    });
  });

  describe('findRunningIterations()', () => {
    it('should find iterations where both loop and iteration are running', async () => {
      const running = createTestLoop();
      const completed = createTestLoop();
      await repo.save(running);
      await repo.save(completed);

      // Complete the second loop
      const updatedCompleted = { ...completed, status: LoopStatus.COMPLETED, updatedAt: Date.now() };
      await repo.update(updatedCompleted);

      // Add running iterations to both loops (need unique task IDs)
      const runningTaskId = TaskId('task-running-iter');
      const completedTaskId = TaskId('task-completed-iter');
      await createTaskInRepo(runningTaskId);
      await createTaskInRepo(completedTaskId);
      await repo.recordIteration(createTestIteration(running.id, 1, { status: 'running', taskId: runningTaskId }));
      await repo.recordIteration(createTestIteration(completed.id, 1, { status: 'running', taskId: completedTaskId }));

      const result = await repo.findRunningIterations();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only the iteration from the running loop should be returned
      expect(result.value).toHaveLength(1);
      expect(result.value[0].loopId).toBe(running.id);
    });

    it('should not include completed iterations on running loops', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1, { status: 'pass' });

      const result = await repo.findRunningIterations();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });
  });

  describe('updateIteration()', () => {
    it('should update iteration status, score, exitCode, and completedAt', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);

      // Fetch the iteration to get the auto-generated ID
      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      const iteration = iters.value[0];
      const now = Date.now();
      const updateResult = await repo.updateIteration({
        ...iteration,
        status: 'pass',
        score: 42.5,
        exitCode: 0,
        completedAt: now,
      });
      expect(updateResult.ok).toBe(true);

      // Re-fetch and verify
      const updated = await repo.getIterations(loop.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.value[0].status).toBe('pass');
      expect(updated.value[0].score).toBe(42.5);
      expect(updated.value[0].exitCode).toBe(0);
      expect(updated.value[0].completedAt).toBeDefined();
    });

    it('should update error message on failure', async () => {
      const loop = createTestLoop();
      await repo.save(loop);
      await saveIteration(loop.id, 1);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      const iteration = iters.value[0];
      await repo.updateIteration({
        ...iteration,
        status: 'fail',
        errorMessage: 'Exit condition failed',
        exitCode: 1,
        completedAt: Date.now(),
      });

      const updated = await repo.getIterations(loop.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.value[0].status).toBe('fail');
      expect(updated.value[0].errorMessage).toBe('Exit condition failed');
    });
  });

  describe('Sync operations (for transactions)', () => {
    it('updateSync should update loop fields', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const updated = { ...loop, currentIteration: 3, consecutiveFailures: 1, updatedAt: Date.now() };
      repo.updateSync(updated);

      const found = repo.findByIdSync(loop.id);
      expect(found).toBeDefined();
      expect(found!.currentIteration).toBe(3);
      expect(found!.consecutiveFailures).toBe(1);
    });

    it('findByIdSync should return null when not found', () => {
      const found = repo.findByIdSync(LoopId('no-such-loop'));
      expect(found).toBeNull();
    });

    it('recordIterationSync should record an iteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-sync-record');
      await createTaskInRepo(taskId);
      repo.recordIterationSync(createTestIteration(loop.id, 1, { taskId }));

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      expect(iters.value).toHaveLength(1);
    });

    it('updateIterationSync should update an iteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      const iteration = iters.value[0];
      repo.updateIterationSync({
        ...iteration,
        status: 'pass',
        exitCode: 0,
        completedAt: Date.now(),
      });

      const updated = await repo.getIterations(loop.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.value[0].status).toBe('pass');
    });

    it('should work correctly inside Database.runInTransaction', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-tx-test');
      await createTaskInRepo(taskId);

      const result = db.runInTransaction(() => {
        const updated = { ...loop, currentIteration: 1, updatedAt: Date.now() };
        repo.updateSync(updated);
        repo.recordIterationSync(createTestIteration(loop.id, 1, { taskId }));
      });

      expect(result.ok).toBe(true);

      // Verify both operations committed
      const found = repo.findByIdSync(loop.id);
      expect(found!.currentIteration).toBe(1);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(1);
    });

    it('should rollback all operations when transaction fails', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const result = db.runInTransaction(() => {
        const updated = { ...loop, currentIteration: 99, updatedAt: Date.now() };
        repo.updateSync(updated);
        throw new Error('simulated failure');
      });

      expect(result.ok).toBe(false);

      // currentIteration should not have changed
      const found = repo.findByIdSync(loop.id);
      expect(found!.currentIteration).toBe(0);
    });
  });

  describe('JSON serialization round-trips', () => {
    it('should serialize and deserialize pipeline_steps correctly', async () => {
      const loop = createTestLoop({
        pipelineSteps: ['lint the code', 'run the tests', 'build the project'],
      });

      await repo.save(loop);
      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.pipelineSteps).toBeDefined();
      expect(findResult.value!.pipelineSteps).toHaveLength(3);
      expect(findResult.value!.pipelineSteps![0]).toBe('lint the code');
      expect(findResult.value!.pipelineSteps![2]).toBe('build the project');
    });

    it('should return undefined pipelineSteps for non-pipeline loops', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.pipelineSteps).toBeUndefined();
    });

    it('should serialize and deserialize pipeline_task_ids in iterations', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskIds = [TaskId('task-a'), TaskId('task-b'), TaskId('task-c')];
      // Create all tasks for FK constraint, then record iteration using the last task as the main task_id
      for (const tid of taskIds) {
        await createTaskInRepo(tid);
      }
      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId: taskIds[2], pipelineTaskIds: taskIds }));

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      expect(iters.value[0].pipelineTaskIds).toBeDefined();
      expect(iters.value[0].pipelineTaskIds).toHaveLength(3);
      expect(iters.value[0].pipelineTaskIds![0]).toBe('task-a');
      expect(iters.value[0].pipelineTaskIds![2]).toBe('task-c');
    });
  });

  describe('Boolean/integer conversion for fresh_context', () => {
    it('should store freshContext=true as 1 and retrieve as true', async () => {
      const loop = createTestLoop({ freshContext: true });
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.freshContext).toBe(true);
    });

    it('should store freshContext=false as 0 and retrieve as false', async () => {
      const loop = createTestLoop({ freshContext: false });
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.freshContext).toBe(false);
    });
  });

  describe('LoopStatus mapping', () => {
    it('should correctly map all status values', async () => {
      const statuses = [LoopStatus.RUNNING, LoopStatus.COMPLETED, LoopStatus.FAILED, LoopStatus.CANCELLED];

      for (const status of statuses) {
        const loop = createTestLoop();
        await repo.save(loop);
        const updated = { ...loop, status, updatedAt: Date.now() };
        await repo.update(updated);

        const result = await repo.findById(loop.id);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value?.status).toBe(status);
      }
    });
  });

  describe('LoopStrategy mapping', () => {
    it('should correctly map retry strategy', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.strategy).toBe(LoopStrategy.RETRY);
    });

    it('should correctly map optimize strategy', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.strategy).toBe(LoopStrategy.OPTIMIZE);
    });
  });

  describe('OptimizeDirection mapping', () => {
    it('should correctly map minimize direction', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MINIMIZE,
      });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.evalDirection).toBe(OptimizeDirection.MINIMIZE);
    });

    it('should correctly map maximize direction', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.evalDirection).toBe(OptimizeDirection.MAXIMIZE);
    });

    it('should return undefined evalDirection for retry strategy', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.evalDirection).toBeUndefined();
    });
  });

  describe('cleanupOldLoops()', () => {
    it('should delete completed loops older than threshold', async () => {
      const loop = createTestLoop();
      await repo.save(loop);
      const completedLoop = {
        ...loop,
        status: LoopStatus.COMPLETED,
        completedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
        updatedAt: Date.now(),
      };
      await repo.update(completedLoop);

      // Create a running loop (should NOT be deleted)
      const runningLoop = createTestLoop();
      await repo.save(runningLoop);

      const result = await repo.cleanupOldLoops(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(1);

      // Running loop should still exist
      const remaining = await repo.findAll();
      expect(remaining.ok).toBe(true);
      if (!remaining.ok) return;
      expect(remaining.value).toHaveLength(1);
      expect(remaining.value[0].id).toBe(runningLoop.id);
    });

    it('should not delete recently completed loops', async () => {
      const loop = createTestLoop();
      await repo.save(loop);
      const completedLoop = {
        ...loop,
        status: LoopStatus.COMPLETED,
        completedAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
        updatedAt: Date.now(),
      };
      await repo.update(completedLoop);

      const result = await repo.cleanupOldLoops(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    it('should cascade delete iterations when loop is cleaned up', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      // Add iterations
      await saveIteration(loop.id, 1);
      await saveIteration(loop.id, 2);

      // Complete the loop with old timestamp
      const completedLoop = {
        ...loop,
        status: LoopStatus.COMPLETED,
        completedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now(),
      };
      await repo.update(completedLoop);

      const result = await repo.cleanupOldLoops(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(1);

      // Iterations should also be gone (cascade)
      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(0);
    });

    it('should delete failed and cancelled loops older than threshold', async () => {
      const failedLoop = createTestLoop();
      await repo.save(failedLoop);
      await repo.update({
        ...failedLoop,
        status: LoopStatus.FAILED,
        completedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now(),
      });

      const cancelledLoop = createTestLoop();
      await repo.save(cancelledLoop);
      await repo.update({
        ...cancelledLoop,
        status: LoopStatus.CANCELLED,
        completedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now(),
      });

      const result = await repo.cleanupOldLoops(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(2);
    });

    it('should return 0 when no loops qualify for cleanup', async () => {
      const result = await repo.cleanupOldLoops(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });
  });

  describe('NULL task_id handling (ON DELETE SET NULL)', () => {
    it('should return undefined taskId when task_id is NULL in database', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      // Create a task, record iteration, then delete the task (triggers ON DELETE SET NULL)
      const taskId = TaskId('task-to-delete');
      await createTaskInRepo(taskId);
      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId }));

      // Delete the task — ON DELETE SET NULL should set task_id to NULL
      db.getDatabase().prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

      // Retrieve iteration — taskId should be undefined (not empty string)
      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(1);
      expect(iters.value[0].taskId).toBeUndefined();
    });

    it('should pass null to SQLite when taskId is undefined in recordIteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      // Record iteration with no taskId (simulates edge case)
      const iteration = createTestIteration(loop.id, 1, { taskId: undefined });
      await repo.recordIteration(iteration);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(1);
      expect(iters.value[0].taskId).toBeUndefined();
    });
  });

  // ==========================================================================
  // v0.8.0 Fields: PAUSED status, git fields, scheduleId, findByScheduleId
  // ==========================================================================

  describe('PAUSED status round-trip', () => {
    it('should save and read a loop with PAUSED status', async () => {
      const loop = createTestLoop();
      // Save as RUNNING then update to PAUSED
      await repo.save(loop);
      const paused = { ...loop, status: LoopStatus.PAUSED, updatedAt: Date.now() };
      await repo.update(paused);

      const found = await repo.findById(loop.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeDefined();
      expect(found.value!.status).toBe(LoopStatus.PAUSED);
    });
  });

  describe('Git fields on loop (v0.8.0)', () => {
    it('should save and read gitBranch, gitBaseBranch, and scheduleId', async () => {
      const { ScheduleId: SID } = await import('../../../src/core/domain');

      // Create schedule to satisfy FK constraint
      const schedule = createSchedule({
        taskTemplate: { prompt: 'placeholder', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
      });
      const schedOverridden = { ...schedule, id: SID('sched-abc-123') };
      await scheduleRepo.save(schedOverridden);

      const loop = createLoop(
        { prompt: 'git test', strategy: LoopStrategy.RETRY, exitCondition: 'true', gitBranch: 'feat/loop-work' },
        '/tmp',
        SID('sched-abc-123'),
      );
      // Override gitBaseBranch (set via LoopManager, not factory)
      const loopWithGit = { ...loop, gitBaseBranch: 'main' };
      await repo.save(loopWithGit);

      const found = await repo.findById(loopWithGit.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeDefined();
      expect(found.value!.gitBranch).toBe('feat/loop-work');
      expect(found.value!.gitBaseBranch).toBe('main');
      expect(found.value!.scheduleId).toBe('sched-abc-123');
    });

    it('should default git fields to undefined when not set', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const found = await repo.findById(loop.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value!.gitBranch).toBeUndefined();
      expect(found.value!.gitBaseBranch).toBeUndefined();
      expect(found.value!.scheduleId).toBeUndefined();
    });
  });

  describe('Git fields on iteration (v0.8.0)', () => {
    it('should save and read gitBranch and gitDiffSummary on iterations', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-git-iter-1');
      await createTaskInRepo(taskId);

      await repo.recordIteration({
        id: 0,
        loopId: loop.id,
        iterationNumber: 1,
        taskId,
        status: 'pass',
        startedAt: Date.now(),
        completedAt: Date.now(),
        gitBranch: 'feat/loop-iter-1',
        gitDiffSummary: ' src/main.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)',
      });

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(1);
      expect(iters.value[0].gitBranch).toBe('feat/loop-iter-1');
      expect(iters.value[0].gitDiffSummary).toContain('src/main.ts');
    });

    it('should default iteration git fields to undefined when not set', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-no-git-iter');
      await createTaskInRepo(taskId);

      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId }));

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value[0].gitBranch).toBeUndefined();
      expect(iters.value[0].gitDiffSummary).toBeUndefined();
    });
  });

  describe('gitStartCommitSha on loops (v0.8.1)', () => {
    it('should save and read gitStartCommitSha', async () => {
      const loop = createLoop({ prompt: 'git sha test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      const loopWithGit = { ...loop, gitStartCommitSha: 'abc1234567890abcdef1234567890abcdef123456' };
      await repo.save(loopWithGit);

      const found = await repo.findById(loopWithGit.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeDefined();
      expect(found.value!.gitStartCommitSha).toBe('abc1234567890abcdef1234567890abcdef123456');
    });

    it('should default gitStartCommitSha to undefined when not set', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const found = await repo.findById(loop.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value!.gitStartCommitSha).toBeUndefined();
    });
  });

  describe('gitCommitSha and preIterationCommitSha on iterations (v0.8.1)', () => {
    it('should save and read gitCommitSha and preIterationCommitSha', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-git-iter-sha');
      await createTaskInRepo(taskId);

      await repo.recordIteration({
        id: 0,
        loopId: loop.id,
        iterationNumber: 1,
        taskId,
        status: 'pass',
        startedAt: Date.now(),
        completedAt: Date.now(),
        preIterationCommitSha: 'pre_abc1234567890abcdef1234567890abcdef1234',
        gitCommitSha: 'post_def4567890abcdef1234567890abcdef12345678',
      });

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(1);
      expect(iters.value[0].preIterationCommitSha).toBe('pre_abc1234567890abcdef1234567890abcdef1234');
      expect(iters.value[0].gitCommitSha).toBe('post_def4567890abcdef1234567890abcdef12345678');
    });

    it('should default iteration git SHA fields to undefined when not set', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-no-git-sha-iter');
      await createTaskInRepo(taskId);
      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId }));

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value[0].preIterationCommitSha).toBeUndefined();
      expect(iters.value[0].gitCommitSha).toBeUndefined();
    });
  });

  describe('findByScheduleId (v0.8.0)', () => {
    // Helper: create a schedule in the DB so FK constraints are satisfied
    async function createScheduleInRepo(scheduleId: string): Promise<void> {
      const { ScheduleId: SID } = await import('../../../src/core/domain');
      const schedule = createSchedule({
        taskTemplate: { prompt: 'placeholder', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
      });
      // Override the schedule id to match the desired value
      const overridden = { ...schedule, id: SID(scheduleId) };
      await scheduleRepo.save(overridden);
    }

    it('should return loops matching a schedule ID', async () => {
      const { ScheduleId: SID } = await import('../../../src/core/domain');
      const sid = SID('sched-find-test');

      // Create the referenced schedule to satisfy FK constraint
      await createScheduleInRepo('sched-find-test');

      // Use createLoop with scheduleId as third arg
      const loop1 = createLoop({ prompt: 'loop 1', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp', sid);
      const loop2 = createLoop({ prompt: 'loop 2', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp', sid);
      const loop3 = createTestLoop(); // No scheduleId

      await repo.save(loop1);
      await repo.save(loop2);
      await repo.save(loop3);

      const result = await repo.findByScheduleId(sid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value.map((l) => l.id)).toContain(loop1.id);
      expect(result.value.map((l) => l.id)).toContain(loop2.id);
    });

    it('should return empty array for non-matching schedule ID', async () => {
      const { ScheduleId: SID } = await import('../../../src/core/domain');
      const sid = SID('sched-nonexistent');

      const result = await repo.findByScheduleId(sid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });
  });
});

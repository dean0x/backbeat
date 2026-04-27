/**
 * Unit tests for PipelineHandler
 * ARCHITECTURE: Real in-memory SQLite + InMemoryEventBus — no process spawning.
 * Pattern: Behavior-driven, testing observable pipeline status transitions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPipeline,
  createTask,
  type Pipeline,
  PipelineId,
  PipelineStatus,
  TaskId,
  TaskStatus,
} from '../../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus.js';
import { Database } from '../../../../src/implementations/database.js';
import { SQLitePipelineRepository } from '../../../../src/implementations/pipeline-repository.js';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository.js';
import { PipelineHandler } from '../../../../src/services/handlers/pipeline-handler.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('PipelineHandler', () => {
  let eventBus: InMemoryEventBus;
  let db: Database;
  let pipelineRepo: SQLitePipelineRepository;
  let taskRepo: SQLiteTaskRepository;
  let logger: TestLogger;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    db = new Database(':memory:');
    pipelineRepo = new SQLitePipelineRepository(db);
    taskRepo = new SQLiteTaskRepository(db);

    const createResult = await PipelineHandler.create({
      pipelineRepository: pipelineRepo,
      taskRepository: taskRepo,
      eventBus,
      logger,
    });
    expect(createResult.ok).toBe(true);
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  // Helpers

  async function savePipelineWithTasks(taskIds: TaskId[], status = PipelineStatus.RUNNING): Promise<Pipeline> {
    const pipeline = createPipeline({
      steps: taskIds.map((_, i) => ({ index: i, prompt: `Step ${i}` })),
      stepTaskIds: taskIds,
    });
    const stored: Pipeline = { ...pipeline, status };
    await pipelineRepo.save(stored);

    for (const tid of taskIds) {
      const task = createTask({ prompt: 'step task' });
      await taskRepo.save({ ...task, id: tid });
    }

    return stored;
  }

  // ============================================================================
  // TaskCompleted — last step completing triggers PipelineCompleted
  // ============================================================================

  describe('TaskCompleted — all steps complete', () => {
    it('marks pipeline as COMPLETED when last step task completes', async () => {
      const taskId = TaskId('task-step-0');
      const pipeline = await savePipelineWithTasks([taskId]);

      // Mark the task as completed in the repo
      await taskRepo.update(taskId, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 1000 });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.COMPLETED);
    });

    it('emits PipelineCompleted event', async () => {
      const completedPipelineIds: PipelineId[] = [];
      eventBus.on('PipelineCompleted', (evt) => {
        completedPipelineIds.push((evt as { pipelineId: PipelineId }).pipelineId);
      });

      const taskId = TaskId('task-step-x');
      await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 500 });
      await flushEventLoop();

      expect(completedPipelineIds).toHaveLength(1);
    });
  });

  // ============================================================================
  // TaskFailed — step failing triggers PipelineFailed
  // ============================================================================

  describe('TaskFailed — step fails', () => {
    it('marks pipeline as FAILED when a step task fails', async () => {
      const taskId = TaskId('task-fail-step');
      const pipeline = await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.FAILED });

      const { AutobeatError, ErrorCode } = await import('../../../../src/core/errors.js');
      await eventBus.emit('TaskFailed', {
        taskId,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'something broke'),
      });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.FAILED);
    });
  });

  // ============================================================================
  // TaskCancelled — step cancellation triggers PipelineCancelled
  // ============================================================================

  describe('TaskCancelled — step cancelled', () => {
    it('marks pipeline as CANCELLED when a step task is cancelled', async () => {
      const taskId = TaskId('task-cancel-step');
      const pipeline = await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.CANCELLED });

      await eventBus.emit('TaskCancelled', { taskId, reason: 'user request' });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.CANCELLED);
    });
  });

  // ============================================================================
  // No pipeline — task with no pipeline association is a no-op
  // ============================================================================

  describe('tasks not associated with any pipeline', () => {
    it('does not error when task does not belong to any pipeline', async () => {
      const taskId = TaskId('unrelated-task');
      const task = createTask({ prompt: 'unrelated' });
      await taskRepo.save({ ...task, id: taskId });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // No pipelines should exist
      const allPipelines = await pipelineRepo.findAll();
      expect(allPipelines.ok).toBe(true);
      if (!allPipelines.ok) throw new Error();
      expect(allPipelines.value).toHaveLength(0);
    });
  });

  // ============================================================================
  // Multi-step pipeline — partial completion does not complete pipeline
  // ============================================================================

  describe('multi-step pipeline', () => {
    it('stays running when only first step of two completes', async () => {
      const taskId0 = TaskId('task-multi-0');
      const taskId1 = TaskId('task-multi-1');
      const pipeline = await savePipelineWithTasks([taskId0, taskId1]);

      // Only task 0 completes — task 1 still queued
      await taskRepo.update(taskId0, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId: taskId0, exitCode: 0, duration: 500 });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      // Still running — second step pending (queued)
      expect(result.value?.status).toBe(PipelineStatus.RUNNING);
    });
  });
});

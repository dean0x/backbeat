/**
 * Unit tests for SQLiteOrchestrationRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoop,
  createOrchestration,
  LoopId,
  LoopStrategy,
  type Orchestration,
  OrchestratorId,
  OrchestratorStatus,
  updateOrchestration,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../../src/implementations/orchestration-repository.js';

describe('SQLiteOrchestrationRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLiteOrchestrationRepository;
  let loopRepo: SQLiteLoopRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteOrchestrationRepository(db);
    loopRepo = new SQLiteLoopRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTestOrchestration(overrides: Partial<Orchestration> = {}): Orchestration {
    return {
      ...createOrchestration({ goal: 'Build a new feature' }, '/tmp/state.json', '/workspace'),
      ...overrides,
    } as Orchestration;
  }

  describe('save() and findById()', () => {
    it('should save and retrieve an orchestration by ID', async () => {
      const orch = createTestOrchestration();
      const saveResult = await repo.save(orch);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(orch.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).not.toBeNull();
      expect(findResult.value?.id).toBe(orch.id);
      expect(findResult.value?.goal).toBe('Build a new feature');
      expect(findResult.value?.status).toBe(OrchestratorStatus.PLANNING);
      expect(findResult.value?.maxDepth).toBe(3);
      expect(findResult.value?.maxWorkers).toBe(5);
      expect(findResult.value?.maxIterations).toBe(50);
    });

    it('should return null for non-existent ID', async () => {
      const result = await repo.findById(OrchestratorId('orchestrator-nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update an existing orchestration', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      // Create a loop first for FK constraint
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      const updated = updateOrchestration(orch, {
        status: OrchestratorStatus.RUNNING,
        loopId: loop.id,
      });
      const updateResult = await repo.update(updated);
      expect(updateResult.ok).toBe(true);

      const findResult = await repo.findById(orch.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value?.status).toBe(OrchestratorStatus.RUNNING);
    });
  });

  describe('findAll()', () => {
    it('should return all orchestrations with pagination', async () => {
      const o1 = createTestOrchestration();
      const o2 = createTestOrchestration();
      await repo.save(o1);
      await repo.save(o2);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    it('should respect limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.save(createTestOrchestration());
      }

      const result = await repo.findAll(2, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });
  });

  describe('findByStatus()', () => {
    it('should filter by status', async () => {
      const planning = createTestOrchestration();
      await repo.save(planning);

      const running = createTestOrchestration();
      const runningUpdated = updateOrchestration(running, { status: OrchestratorStatus.RUNNING });
      await repo.save(runningUpdated);

      const result = await repo.findByStatus(OrchestratorStatus.PLANNING);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0].status).toBe(OrchestratorStatus.PLANNING);
    });
  });

  describe('findByLoopId()', () => {
    it('should find orchestration by loop ID', async () => {
      // Create a loop first for FK constraint
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      const orch = createTestOrchestration();
      const withLoop = updateOrchestration(orch, { loopId: loop.id });
      await repo.save(withLoop);

      const result = await repo.findByLoopId(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value?.id).toBe(orch.id);
    });

    it('should return null for unknown loop ID', async () => {
      const result = await repo.findByLoopId(LoopId('loop-unknown'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('delete()', () => {
    it('should delete an orchestration', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      const deleteResult = await repo.delete(orch.id);
      expect(deleteResult.ok).toBe(true);

      const findResult = await repo.findById(orch.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).toBeNull();
    });
  });

  describe('cleanupOldOrchestrations()', () => {
    it('should delete terminal orchestrations older than retention', async () => {
      const oldOrch = createTestOrchestration();
      const oldCompleted = updateOrchestration(oldOrch, {
        status: OrchestratorStatus.COMPLETED,
        completedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      });
      await repo.save(oldCompleted);

      const recentOrch = createTestOrchestration();
      const recentCompleted = updateOrchestration(recentOrch, {
        status: OrchestratorStatus.COMPLETED,
        completedAt: Date.now(),
      });
      await repo.save(recentCompleted);

      const result = await repo.cleanupOldOrchestrations(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(1);
    });

    it('should not delete running orchestrations', async () => {
      const running = createTestOrchestration();
      const updated = updateOrchestration(running, { status: OrchestratorStatus.RUNNING });
      await repo.save(updated);

      const result = await repo.cleanupOldOrchestrations(0); // Even with 0 retention
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });
  });

  describe('sync operations', () => {
    it('saveSync and findByIdSync should work', () => {
      const orch = createTestOrchestration();
      repo.saveSync(orch);

      const found = repo.findByIdSync(orch.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(orch.id);
    });

    it('updateSync should update orchestration', () => {
      const orch = createTestOrchestration();
      repo.saveSync(orch);

      const updated = updateOrchestration(orch, { status: OrchestratorStatus.FAILED });
      repo.updateSync(updated);

      const found = repo.findByIdSync(orch.id);
      expect(found?.status).toBe(OrchestratorStatus.FAILED);
    });

    it('findByLoopIdSync should find by loop ID', async () => {
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      const orch = createTestOrchestration();
      const withLoop = updateOrchestration(orch, { loopId: loop.id });
      repo.saveSync(withLoop);

      const found = repo.findByLoopIdSync(loop.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(orch.id);
    });
  });
});

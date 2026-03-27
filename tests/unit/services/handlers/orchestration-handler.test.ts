/**
 * Unit tests for OrchestrationHandler
 * ARCHITECTURE: Tests event-driven orchestration lifecycle
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoop,
  createOrchestration,
  LoopId,
  LoopStatus,
  LoopStrategy,
  OrchestratorStatus,
  updateLoop,
  updateOrchestration,
} from '../../../../src/core/domain.js';
import { Database } from '../../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../../../src/implementations/orchestration-repository.js';
import { OrchestrationHandler } from '../../../../src/services/handlers/orchestration-handler.js';
import { TestEventBus, TestLogger } from '../../../fixtures/test-doubles.js';

describe('OrchestrationHandler - Unit Tests', () => {
  let db: Database;
  let loopRepo: SQLiteLoopRepository;
  let orchRepo: SQLiteOrchestrationRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let handler: OrchestrationHandler;

  beforeEach(async () => {
    db = new Database(':memory:');
    loopRepo = new SQLiteLoopRepository(db);
    orchRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();

    const result = await OrchestrationHandler.create({
      orchestrationRepo: orchRepo,
      loopRepo: loopRepo,
      database: db,
      eventBus,
      logger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Failed to create handler');
    handler = result.value;
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  async function createTestOrchestrationWithLoop() {
    const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
    await loopRepo.save(loop);

    const orch = createOrchestration({ goal: 'Test' }, '/tmp/state.json', '/workspace');
    const withLoop = updateOrchestration(orch, {
      loopId: loop.id,
      status: OrchestratorStatus.RUNNING,
    });
    orchRepo.saveSync(withLoop);

    return { orchestration: withLoop, loop };
  }

  describe('LoopCompleted with COMPLETED status', () => {
    it('should set orchestration to COMPLETED when loop completes successfully', async () => {
      const { orchestration, loop } = await createTestOrchestrationWithLoop();

      // Mark loop as completed
      const completedLoop = updateLoop(loop, { status: LoopStatus.COMPLETED, completedAt: Date.now() });
      loopRepo.updateSync(completedLoop);

      // Emit LoopCompleted
      await eventBus.emit('LoopCompleted', { loopId: loop.id, reason: 'Exit condition met' });

      const found = orchRepo.findByIdSync(orchestration.id);
      expect(found).not.toBeNull();
      expect(found?.status).toBe(OrchestratorStatus.COMPLETED);
      expect(found?.completedAt).toBeDefined();
    });
  });

  describe('LoopCompleted with FAILED status', () => {
    it('should set orchestration to FAILED when loop fails', async () => {
      const { orchestration, loop } = await createTestOrchestrationWithLoop();

      // Mark loop as failed
      const failedLoop = updateLoop(loop, { status: LoopStatus.FAILED, completedAt: Date.now() });
      loopRepo.updateSync(failedLoop);

      // Emit LoopCompleted (both success and failure come through this event)
      await eventBus.emit('LoopCompleted', { loopId: loop.id, reason: 'Max iterations' });

      const found = orchRepo.findByIdSync(orchestration.id);
      expect(found).not.toBeNull();
      expect(found?.status).toBe(OrchestratorStatus.FAILED);
    });
  });

  describe('LoopCancelled', () => {
    it('should set orchestration to CANCELLED when loop is cancelled', async () => {
      const { orchestration, loop } = await createTestOrchestrationWithLoop();

      await eventBus.emit('LoopCancelled', { loopId: loop.id, reason: 'User cancelled' });

      const found = orchRepo.findByIdSync(orchestration.id);
      expect(found).not.toBeNull();
      expect(found?.status).toBe(OrchestratorStatus.CANCELLED);
      expect(found?.completedAt).toBeDefined();
    });
  });

  describe('Unknown loopId', () => {
    it('should be a no-op for loops not owned by any orchestration', async () => {
      // Create a loop that is NOT associated with any orchestration
      const loop = createLoop({ prompt: 'standalone', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      // This should not throw or fail
      await eventBus.emit('LoopCompleted', { loopId: loop.id, reason: 'Done' });
      await eventBus.emit('LoopCancelled', { loopId: loop.id });

      // Verify no orchestrations were affected
      const all = await orchRepo.findAll();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value.length).toBe(0);
    });
  });
});

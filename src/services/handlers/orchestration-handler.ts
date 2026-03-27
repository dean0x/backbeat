/**
 * Orchestration handler for lifecycle management
 * ARCHITECTURE: Event-driven orchestration state management (v0.9.0)
 * Pattern: Factory pattern for async initialization (matches LoopHandler)
 * Rationale: Correlates loop lifecycle events to orchestration status updates
 */

import { LoopId, LoopStatus, OrchestratorStatus, updateOrchestration } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { LoopCancelledEvent, LoopCompletedEvent } from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type {
  Logger,
  SyncLoopOperations,
  SyncOrchestrationOperations,
  TransactionRunner,
} from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';

export interface OrchestrationHandlerDeps {
  readonly orchestrationRepo: SyncOrchestrationOperations;
  readonly loopRepo: SyncLoopOperations;
  readonly database: TransactionRunner;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class OrchestrationHandler extends BaseEventHandler {
  private readonly orchestrationRepo: SyncOrchestrationOperations;
  private readonly loopRepo: SyncLoopOperations;
  private readonly database: TransactionRunner;
  private readonly eventBus: EventBus;

  /**
   * Private constructor - use OrchestrationHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(deps: OrchestrationHandlerDeps) {
    super(deps.logger, 'OrchestrationHandler');
    this.orchestrationRepo = deps.orchestrationRepo;
    this.loopRepo = deps.loopRepo;
    this.database = deps.database;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method to create a fully initialized OrchestrationHandler
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible
   */
  static async create(deps: OrchestrationHandlerDeps): Promise<Result<OrchestrationHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child ? deps.logger.child({ module: 'OrchestrationHandler' }) : deps.logger;

    const handler = new OrchestrationHandler({ ...deps, logger: handlerLogger });

    // Subscribe to loop lifecycle events
    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('OrchestrationHandler initialized');
    return ok(handler);
  }

  /**
   * Subscribe to loop lifecycle events
   * ARCHITECTURE: Called by factory after initialization
   */
  private subscribeToEvents(): Result<void, AutobeatError> {
    const subscriptions = [
      this.eventBus.subscribe<LoopCompletedEvent>('LoopCompleted', async (event) => this.handleLoopCompleted(event)),
      this.eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) => this.handleLoopCancelled(event)),
    ];

    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to events: ${result.error.message}`, {
            error: result.error,
          }),
        );
      }
    }

    return ok(undefined);
  }

  /**
   * Handle LoopCompleted: map loop terminal state to orchestration status
   *
   * IMPORTANT: No LoopFailed event exists. Both success and failure come through
   * LoopCompleted. We must load the loop from SQLite to check its actual status.
   */
  private handleLoopCompleted(event: LoopCompletedEvent): void {
    this.updateOrchestrationForLoop(event.loopId, (loopStatus) => {
      if (loopStatus === LoopStatus.COMPLETED) {
        return OrchestratorStatus.COMPLETED;
      }
      // LoopStatus.FAILED comes through LoopCompleted event
      return OrchestratorStatus.FAILED;
    });
  }

  /**
   * Handle LoopCancelled: mark orchestration as cancelled
   */
  private handleLoopCancelled(event: LoopCancelledEvent): void {
    this.updateOrchestrationForLoop(event.loopId, () => OrchestratorStatus.CANCELLED);
  }

  /**
   * Shared helper: look up orchestration by loopId and update status in a transaction
   */
  private updateOrchestrationForLoop(
    loopId: LoopId,
    resolveStatus: (loopStatus: LoopStatus) => OrchestratorStatus,
  ): void {
    const txResult = this.database.runInTransaction(() => {
      // Find the orchestration that owns this loop
      const orchestration = this.orchestrationRepo.findByLoopIdSync(loopId);
      if (!orchestration) {
        // Not an orchestration-owned loop — no-op
        return;
      }

      // Load the loop to get its actual status
      const loop = this.loopRepo.findByIdSync(loopId);
      const loopStatus = loop?.status ?? LoopStatus.FAILED;

      const newStatus = resolveStatus(loopStatus);
      const updated = updateOrchestration(orchestration, {
        status: newStatus,
        completedAt: Date.now(),
      });

      this.orchestrationRepo.updateSync(updated);

      this.logger.info('Orchestration status updated from loop event', {
        orchestratorId: orchestration.id,
        loopId,
        newStatus,
        loopStatus,
      });
    });

    if (!txResult.ok) {
      this.logger.error('Failed to update orchestration status', txResult.error, { loopId });
    }
  }
}

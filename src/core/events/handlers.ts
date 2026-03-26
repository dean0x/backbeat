/**
 * Base event handler classes and utilities
 * Provides common patterns for event handling
 */

import { AutobeatError, ErrorCode } from '../errors.js';
import { Logger } from '../interfaces.js';
import { err, ok, Result } from '../result.js';
import { EventBus } from './event-bus.js';
import { AutobeatEvent, EventHandler } from './events.js';

/**
 * Base event handler with common functionality
 */
export abstract class BaseEventHandler {
  constructor(
    protected readonly logger: Logger,
    protected readonly name: string,
  ) {}

  /**
   * Emit an event with standardized error handling.
   * Reduces boilerplate for event emission across handlers.
   *
   * @param eventBus - The event bus to emit on
   * @param eventType - The event type name (e.g., 'TaskQueued')
   * @param payload - The event payload (without type/eventId - those are added automatically)
   * @param options - Optional settings for error handling
   * @returns Result indicating success or failure
   *
   * @example
   * ```typescript
   * await this.emitEvent(this.eventBus, 'TaskQueued', { taskId, task }, {
   *   logOnError: true,   // Log if emit fails (default: true)
   *   context: { taskId } // Extra context for error logs
   * });
   * ```
   */
  protected async emitEvent<T extends AutobeatEvent['type']>(
    eventBus: EventBus,
    eventType: T,
    payload: Record<string, unknown>,
    options?: {
      logOnError?: boolean;
      context?: Record<string, unknown>;
    },
  ): Promise<Result<void>> {
    // ARCHITECTURE EXCEPTION: Using 'as any' for EventBus.emit type compatibility
    // TypeScript cannot infer the correct payload type from a string event type at this
    // generic helper call site. This is a TypeScript limitation, not a design flaw.
    // Safety: EventBus.emit() wraps payload in createEvent() which adds eventId/timestamp.
    // The alternative would be no DRY helper at all - this trade-off is acceptable.
    // biome-ignore lint/suspicious/noExplicitAny: TS can't infer payload type from string event type in DRY helper
    const result = await eventBus.emit(eventType as any, payload as any);

    if (!result.ok && (options?.logOnError ?? true)) {
      this.logger.error(`Failed to emit ${eventType} event`, result.error, {
        handlerName: this.name,
        ...options?.context,
      });
    }

    return result;
  }

  /**
   * Handle an event with error logging
   * ARCHITECTURE: Returns Result instead of throwing to maintain consistency
   */
  protected async handleEvent<T extends AutobeatEvent>(
    event: T,
    handler: (event: T) => Promise<Result<void>>,
  ): Promise<Result<void>> {
    this.logger.debug(`${this.name} handling event`, {
      eventType: event.type,
      eventId: event.eventId,
    });

    const result = await handler(event);

    if (!result.ok) {
      this.logger.error(`${this.name} event handling failed`, result.error, {
        eventType: event.type,
        eventId: event.eventId,
      });

      return result;
    }

    this.logger.debug(`${this.name} event handled successfully`, {
      eventType: event.type,
      eventId: event.eventId,
    });

    return ok(undefined);
  }
}

/**
 * Event handler registry for organizing handlers
 */
export class EventHandlerRegistry {
  private readonly handlers: BaseEventHandler[] = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {}

  /**
   * Register an event handler
   */
  register(handler: BaseEventHandler): Result<void> {
    this.handlers.push(handler);

    this.logger.debug('Event handler registered', {
      handlerName: handler.constructor.name,
      totalHandlers: this.handlers.length,
    });

    return ok(undefined);
  }

  /**
   * Register multiple handlers
   */
  registerAll(handlers: BaseEventHandler[]): Result<void> {
    for (const handler of handlers) {
      const result = this.register(handler);
      if (!result.ok) {
        return result;
      }
    }
    return ok(undefined);
  }

  /**
   * Initialize all handlers by subscribing them to events
   */
  async initialize(): Promise<Result<void>> {
    try {
      for (const handler of this.handlers) {
        // Each handler should have its own setup method
        if ('setup' in handler && typeof handler.setup === 'function') {
          const result = await handler.setup(this.eventBus);
          if (!result.ok) {
            return result;
          }
        }
      }

      this.logger.info('Event handler registry initialized', {
        handlerCount: this.handlers.length,
      });

      return ok(undefined);
    } catch (error) {
      return err(new AutobeatError(ErrorCode.SYSTEM_ERROR, `Event handler registry initialization failed: ${error}`));
    }
  }

  /**
   * Shutdown all handlers
   */
  async shutdown(): Promise<Result<void>> {
    try {
      for (const handler of this.handlers) {
        if ('teardown' in handler && typeof handler.teardown === 'function') {
          await handler.teardown();
        }
      }

      this.logger.info('Event handler registry shutdown complete');
      return ok(undefined);
    } catch (error) {
      return err(new AutobeatError(ErrorCode.SYSTEM_ERROR, `Event handler registry shutdown failed: ${error}`));
    }
  }
}

/**
 * Retry logic for event handlers
 */
export class RetryableEventHandler extends BaseEventHandler {
  constructor(
    logger: Logger,
    name: string,
    private readonly maxRetries: number = 3,
    private readonly retryDelayMs: number = 1000,
  ) {
    super(logger, name);
  }

  /**
   * Execute handler with retry logic
   * ARCHITECTURE: Returns Result instead of throwing
   */
  protected async executeWithRetry<T extends AutobeatEvent>(
    event: T,
    handler: (event: T) => Promise<Result<void>>,
  ): Promise<Result<void>> {
    let lastError: AutobeatError | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await handler(event);

        if (result.ok) {
          if (attempt > 1) {
            this.logger.info(`${this.name} succeeded on retry`, {
              eventId: event.eventId,
              attempt,
            });
          }
          return ok(undefined);
        }

        lastError =
          result.error instanceof AutobeatError
            ? result.error
            : new AutobeatError(ErrorCode.SYSTEM_ERROR, result.error.message || String(result.error));

        this.logger.warn(`${this.name} failed, attempt ${attempt}/${this.maxRetries}`, {
          eventId: event.eventId,
          error: lastError.message,
        });

        // Wait before retrying (except on last attempt)
        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      } catch (error) {
        lastError = error instanceof AutobeatError ? error : new AutobeatError(ErrorCode.SYSTEM_ERROR, `${error}`);
      }
    }

    // All retries failed - return error instead of throwing
    return err(
      lastError || new AutobeatError(ErrorCode.SYSTEM_ERROR, `${this.name} failed after ${this.maxRetries} attempts`),
    );
  }
}

/**
 * Utility to create simple event handler functions
 * ARCHITECTURE: Logs errors but doesn't throw - EventBus handles error propagation
 */
export function createEventHandler<T extends AutobeatEvent>(
  handler: (event: T) => Promise<Result<void>>,
  logger: Logger,
  name: string,
): EventHandler<T> {
  return async (event: T) => {
    logger.debug(`Event handler ${name} processing`, {
      eventType: event.type,
      eventId: event.eventId,
    });

    const result = await handler(event);

    if (!result.ok) {
      logger.error(`Event handler ${name} failed`, result.error, {
        eventType: event.type,
        eventId: event.eventId,
      });
      // Note: EventBus will handle error aggregation and propagation
    }
  };
}

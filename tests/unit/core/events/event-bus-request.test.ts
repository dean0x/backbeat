/**
 * Tests for EventBus request-response pattern
 * Validates correlation-based thread-safe implementation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackbeatError, ErrorCode } from '../../../../src/core/errors.js';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus.js';
import { Logger } from '../../../../src/core/interfaces.js';
import { TEST_COUNTS, TIMEOUTS } from '../../../constants.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';

describe('EventBus Request-Response Pattern', () => {
  let eventBus: InMemoryEventBus;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = new TestLogger();
    // FIXED: Pass config as first parameter, logger as second
    eventBus = new InMemoryEventBus(createTestConfiguration(), mockLogger);
  });

  afterEach(() => {
    // ARCHITECTURE: Clean up EventBus resources to prevent memory leaks
    eventBus.dispose();
    vi.clearAllMocks();
  });

  describe('Basic Request-Response', () => {
    it('should successfully complete request-response cycle', async () => {
      // Set up handler that responds
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        if (event.__correlationId) {
          eventBus.respond(event.__correlationId, { result: 'success' });
        }
      });

      const result = await eventBus.request('TestQuery', { data: 'test' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ result: 'success' });
      }
    });

    it('should handle error responses', async () => {
      // Set up handler that responds with error
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        if (event.__correlationId) {
          eventBus.respondError(event.__correlationId, new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Test error'));
        }
      });

      const result = await eventBus.request('TestQuery', { data: 'test' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.SYSTEM_ERROR);
        expect(result.error.message).toBe('Test error');
      }
    });

    it('should timeout when no response received', async () => {
      // Set up handler that never responds
      eventBus.subscribe('TestQuery', async () => {
        // Do nothing - simulate hanging handler
      });

      const result = await eventBus.request(
        'TestQuery',
        { data: 'test' },
        100, // 100ms timeout
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timeout');
        expect(result.error.message).toContain('100ms');
      }
    });

    it('should return error when no handlers registered', async () => {
      const result = await eventBus.request('UnhandledQuery', { data: 'test' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('No handlers registered');
        expect(result.error.message).toContain('UnhandledQuery');
      }
    });
  });

  describe('Correlation ID Management', () => {
    it('should generate unique correlation IDs for each request', async () => {
      const correlationIds = new Set<string>();

      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        correlationIds.add(event.__correlationId);
        eventBus.respond(event.__correlationId, 'ok');
      });

      // Make multiple requests
      await Promise.all([
        eventBus.request('TestQuery', {}),
        eventBus.request('TestQuery', {}),
        eventBus.request('TestQuery', {}),
      ]);

      // Should have 3 unique correlation IDs
      expect(correlationIds.size).toBe(3);
    });

    it('should clean up pending requests after response', async () => {
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        eventBus.respond(event.__correlationId, 'done');
      });

      await eventBus.request('TestQuery', {});

      // Check internal state is cleaned up
      expect((eventBus as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
    });

    it('should clean up pending requests after error', async () => {
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        eventBus.respondError(event.__correlationId, new Error('failed'));
      });

      await eventBus.request('TestQuery', {});

      // Check internal state is cleaned up
      expect((eventBus as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
    });

    it('should clean up pending requests after timeout', async () => {
      // FIXED: Use real timeout with SHORT duration
      eventBus.subscribe('TestQuery', async () => {
        // Never respond
      });

      await eventBus.request('TestQuery', {}, TIMEOUTS.SHORT);

      // Check internal state is cleaned up
      expect((eventBus as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
    });

    it('should ignore responses for unknown correlation IDs', () => {
      // Should not throw
      expect(() => {
        eventBus.respond('unknown-id', 'data');
        eventBus.respondError('unknown-id', new Error('error'));
      }).not.toThrow();
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple concurrent requests correctly', async () => {
      // FIXED: Use real timers with immediate responses for reliability
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        const value = event.value;
        // Immediate response without setTimeout complexity
        eventBus.respond(event.__correlationId, value * 2);
      });

      // Make concurrent requests
      const promises = Array.from({ length: TEST_COUNTS.MEDIUM_SET }, (_, i) =>
        eventBus.request('TestQuery', { value: i }),
      );

      const results = await Promise.all(promises);

      // Verify all succeeded and got correct responses
      results.forEach((result, i) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(i * 2);
        }
      });
    });

    it('should handle mixed success and failure responses', async () => {
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        const value = event.value;
        if (value % 2 === 0) {
          eventBus.respond(event.__correlationId, `success-${value}`);
        } else {
          eventBus.respondError(event.__correlationId, new Error(`error-${value}`));
        }
      });

      const promises = Array.from({ length: 6 }, (_, i) => eventBus.request('TestQuery', { value: i }));

      const results = await Promise.all(promises);

      // Even numbers should succeed
      expect(results[0].ok).toBe(true);
      expect(results[2].ok).toBe(true);
      expect(results[4].ok).toBe(true);

      // Odd numbers should fail
      expect(results[1].ok).toBe(false);
      expect(results[3].ok).toBe(false);
      expect(results[5].ok).toBe(false);

      if (results[0].ok) {
        expect(results[0].value).toBe('success-0');
      }
      if (!results[1].ok) {
        expect(results[1].error.message).toContain('error-1');
      }
    });

    it(
      'should handle requests with different timeouts',
      async () => {
        // FIXED: Use real timeouts with SHORT durations
        let handlerCallCount = 0;

        eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
          handlerCallCount++;
          const delay = event.delay;
          await new Promise((resolve) => setTimeout(resolve, delay));
          eventBus.respond(event.__correlationId, 'completed');
        });

        const promises = [
          eventBus.request('TestQuery', { delay: 10 }, TIMEOUTS.MEDIUM), // Fast response, long timeout
          eventBus.request('TestQuery', { delay: 200 }, TIMEOUTS.SHORT), // Slow response, short timeout (100ms)
        ];

        const [fast, slow] = await Promise.all(promises);

        expect(fast.ok).toBe(true); // Should succeed
        expect(slow.ok).toBe(false); // Should timeout
        if (!slow.ok) {
          expect(slow.error.message).toContain('timeout');
        }
        expect(handlerCallCount).toBe(2); // Both handlers called
      },
      TIMEOUTS.LONG,
    ); // Set test timeout
  });

  describe('Handler Execution', () => {
    it('should execute first handler only for requests', async () => {
      let handler1Called = false;
      let handler2Called = false;

      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        handler1Called = true;
        eventBus.respond(event.__correlationId, 'handler1');
      });

      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        handler2Called = true;
        eventBus.respond(event.__correlationId, 'handler2');
      });

      const result = await eventBus.request('TestQuery', {});

      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(false);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('handler1');
      }
    });

    it('should handle handler exceptions gracefully', async () => {
      eventBus.subscribe('TestQuery', async () => {
        throw new Error('Handler crashed');
      });

      const result = await eventBus.request('TestQuery', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Handler crashed');
      }
    });

    it('should handle async handler errors', async () => {
      // FIXED: Provide explicit timeout to avoid undefined timeout issue
      eventBus.subscribe('TestQuery', async () => {
        await Promise.resolve(); // Just needs to be async, no delay needed
        throw new Error('Async error');
      });

      const result = await eventBus.request('TestQuery', {}, TIMEOUTS.MEDIUM);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Async error');
      }
    });

    it('should convert non-Error throws to BackbeatError', async () => {
      eventBus.subscribe('TestQuery', async () => {
        throw 'string error';
      });

      const result = await eventBus.request('TestQuery', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(BackbeatError);
        expect(result.error.message).toContain('string error');
      }
    });
  });

  describe('Custom Timeouts', () => {
    it(
      'should respect custom timeout values',
      async () => {
        // FIXED: Use real timeouts with SHORT duration for reliability
        eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
          // Delay longer than short timeout but less than long timeout
          await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.SHORT + 50));
          eventBus.respond(event.__correlationId, 'done');
        });

        // Should timeout with SHORT duration (100ms)
        const shortResult = await eventBus.request('TestQuery', {}, TIMEOUTS.SHORT);
        expect(shortResult.ok).toBe(false);
        if (!shortResult.ok) {
          expect(shortResult.error.message).toContain('timeout');
        }

        // Should succeed with MEDIUM duration (1000ms)
        const longResult = await eventBus.request('TestQuery', {}, TIMEOUTS.MEDIUM);
        expect(longResult.ok).toBe(true);
      },
      TIMEOUTS.LONG,
    ); // Set test timeout

    it(
      'should timeout with very short custom timeout',
      async () => {
        eventBus.subscribe('TestQuery', async () => {
          // Never respond
        });

        const result = await eventBus.request('TestQuery', {}, TIMEOUTS.SHORT);

        // Should timeout with error
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('timeout');
        }
      },
      TIMEOUTS.MEDIUM,
    ); // Set test timeout
  });

  describe('Memory Management', () => {
    it('should not leak memory with many requests', async () => {
      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        eventBus.respond(event.__correlationId, 'ok');
      });

      // Make many requests
      for (let i = 0; i < TEST_COUNTS.STRESS_TEST; i++) {
        await eventBus.request('TestQuery', { index: i });
      }

      // All should be cleaned up
      expect((eventBus as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
    });

    it('should handle rapid fire requests', async () => {
      let responseCount = 0;

      eventBus.subscribe('TestQuery', async (event: Record<string, unknown>) => {
        responseCount++;
        // Immediate response
        eventBus.respond(event.__correlationId, responseCount);
      });

      // Fire requests without waiting
      const promises = Array.from({ length: 100 }, () => eventBus.request('TestQuery', {}));

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.every((r) => r.ok)).toBe(true);
      expect(responseCount).toBe(100);
    });
  });
});

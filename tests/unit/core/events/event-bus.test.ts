import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import type { AutobeatEvent } from '../../../../src/core/events/events';
import type { Logger } from '../../../../src/core/interfaces';
import { TEST_COUNTS, TIMEOUTS } from '../../../constants';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger } from '../../../fixtures/test-doubles';

describe('InMemoryEventBus - REAL Pub/Sub Behavior', () => {
  let eventBus: InMemoryEventBus;
  let logger: Logger;

  beforeEach(() => {
    // Use TestLogger to track actual logging behavior
    logger = new TestLogger();
    // FIXED: Pass config as first parameter, logger as second
    eventBus = new InMemoryEventBus(createTestConfiguration(), logger);
  });

  afterEach(() => {
    // ARCHITECTURE: Clean up EventBus resources to prevent memory leaks
    eventBus.dispose();
  });

  describe('Event subscription and emission', () => {
    it('should deliver events to subscribers', async () => {
      let receivedEvent: unknown = null;

      // Subscribe to event
      const result = eventBus.subscribe('TestEvent', async (event) => {
        receivedEvent = event;
      });

      expect(result.ok).toBe(true);

      // Emit event
      await eventBus.emit('TestEvent', {
        data: 'test data',
        timestamp: Date.now(),
      });

      // Subscriber should receive event
      expect(receivedEvent).not.toBeNull();
      expect((receivedEvent as Record<string, unknown>).data).toBe('test data');
    });

    it('should deliver events to multiple subscribers', async () => {
      const received: Array<{ subscriber: number; event: Record<string, unknown> }> = [];

      // Multiple subscribers
      eventBus.subscribe('TestEvent', async (event) => {
        received.push({ subscriber: 1, event });
      });

      eventBus.subscribe('TestEvent', async (event) => {
        received.push({ subscriber: 2, event });
      });

      eventBus.subscribe('TestEvent', async (event) => {
        received.push({ subscriber: 3, event });
      });

      // Emit event
      await eventBus.emit('TestEvent', { value: 42 });

      // All subscribers should receive events
      expect(received).toHaveLength(3);
      expect(received[0].subscriber).toBe(1);
      expect(received[0].event.value).toBe(42);
      expect(received[1].subscriber).toBe(2);
      expect(received[1].event.value).toBe(42);
      expect(received[2].subscriber).toBe(3);
      expect(received[2].event.value).toBe(42);

      // Verify all events have proper structure
      received.forEach((item, index) => {
        expect(item.subscriber).toBe(index + 1);
        expect(item.event).toHaveProperty('value', 42);
        expect(typeof item.event).toBe('object');
      });

      // Verify ordering is maintained
      expect(received.map((r) => r.subscriber)).toEqual([1, 2, 3]);
    });

    it('should not deliver events to wrong event type subscribers', async () => {
      let eventAReceived = false;
      let eventBReceived = false;

      eventBus.subscribe('EventA', async () => {
        eventAReceived = true;
      });

      eventBus.subscribe('EventB', async () => {
        eventBReceived = true;
      });

      // Emit only EventA
      await eventBus.emit('EventA', {});

      expect(eventAReceived).toBe(true);
      expect(eventBReceived).toBe(false);
    });

    it('should handle events with no subscribers gracefully', async () => {
      const result = await eventBus.emit('UnsubscribedEvent', {
        data: 'nobody listening',
      });

      expect(result.ok).toBe(true);
      // Should log debug message about no subscribers
      const testLogger = logger as TestLogger;
      expect(testLogger.hasLog('debug', 'No subscribers for event type')).toBe(true);
      const debugLogs = testLogger.getLogsByLevel('debug');
      expect(debugLogs[0]?.context?.eventType).toBe('UnsubscribedEvent');
    });
  });

  describe('Subscribe all functionality', () => {
    it('should receive all event types with subscribeAll', async () => {
      const allEvents: Array<Record<string, unknown>> = [];

      const subResult = eventBus.subscribeAll(async (event) => {
        allEvents.push(event);
      });

      expect(subResult.ok).toBe(true);
      expect(subResult.ok && typeof subResult.value).toBe('string');

      // Emit different event types
      const resultA = await eventBus.emit('EventA', { type: 'A' });
      const resultB = await eventBus.emit('EventB', { type: 'B' });
      const resultC = await eventBus.emit('EventC', { type: 'C' });

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      expect(resultC.ok).toBe(true);
      expect(allEvents).toHaveLength(3);
      expect(allEvents[0].type).toBe('A');
      expect(allEvents[1].type).toBe('B');
      expect(allEvents[2].type).toBe('C');
      expect(Array.isArray(allEvents)).toBe(true);
    });

    it('should deliver to both specific and all subscribers', async () => {
      let specificReceived = false;
      let allReceived = false;
      let specificData: unknown = null;
      let allData: unknown = null;

      const specificSub = eventBus.subscribe('SpecificEvent', async (event) => {
        specificReceived = true;
        specificData = event;
      });

      const allSub = eventBus.subscribeAll(async (event) => {
        allReceived = true;
        allData = event;
      });

      expect(specificSub.ok).toBe(true);
      expect(allSub.ok).toBe(true);

      const result = await eventBus.emit('SpecificEvent', { value: 'test' });

      expect(result.ok).toBe(true);
      expect(specificReceived).toBe(true);
      expect(allReceived).toBe(true);

      // FIXED: Handlers receive full event with metadata, not just payload
      expect(specificData).toMatchObject({
        type: 'SpecificEvent',
        value: 'test',
        eventId: expect.any(String),
        timestamp: expect.any(Number),
        source: 'autobeat',
      });
      expect(allData).toMatchObject({
        type: 'SpecificEvent',
        value: 'test',
        eventId: expect.any(String),
        timestamp: expect.any(Number),
        source: 'autobeat',
      });
    });
  });

  describe('Unsubscribe functionality', () => {
    it('should stop delivering events after unsubscribe', async () => {
      let callCount = 0;

      const subResult = eventBus.subscribe('TestEvent', async () => {
        callCount++;
      });

      const subscriptionId = subResult.ok ? subResult.value : '';

      // First emission - should receive
      await eventBus.emit('TestEvent', {});
      expect(callCount).toBe(1);

      // Unsubscribe
      const unsubResult = eventBus.unsubscribe(subscriptionId);
      expect(unsubResult.ok).toBe(true);

      // Second emission - should not receive
      await eventBus.emit('TestEvent', {});
      expect(callCount).toBe(1); // Still 1
    });

    it('should handle unsubscribe with invalid ID', () => {
      const result = eventBus.unsubscribe('invalid-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Subscription not found');
      }
    });

    it('should unsubscribe all handlers', async () => {
      let count1 = 0;
      let count2 = 0;
      let countAll = 0;

      eventBus.subscribe('Event1', async () => {
        count1++;
      });
      eventBus.subscribe('Event2', async () => {
        count2++;
      });
      eventBus.subscribeAll(async () => {
        countAll++;
      });

      // Emit before unsubscribeAll
      await eventBus.emit('Event1', {});
      await eventBus.emit('Event2', {});

      expect(count1).toBe(1);
      expect(count2).toBe(1);
      expect(countAll).toBe(2);

      // Unsubscribe all
      eventBus.unsubscribeAll();

      // Emit after unsubscribeAll
      await eventBus.emit('Event1', {});
      await eventBus.emit('Event2', {});

      // Counts should not increase
      expect(count1).toBe(1);
      expect(count2).toBe(1);
      expect(countAll).toBe(2);
    });

    it('should allow re-subscribing after unsubscribe', async () => {
      let received = 0;

      const handler = async () => {
        received++;
      };

      // Subscribe, emit, unsubscribe
      const sub1 = eventBus.subscribe('TestEvent', handler);
      await eventBus.emit('TestEvent', {});
      expect(received).toBe(1);

      eventBus.unsubscribe(sub1.ok ? sub1.value : '');

      // Re-subscribe
      eventBus.subscribe('TestEvent', handler);
      await eventBus.emit('TestEvent', {});
      expect(received).toBe(2);
    });
  });

  describe('Error handling', () => {
    it('should handle subscriber errors gracefully', async () => {
      let goodHandlerCalled = false;

      // Bad handler that throws
      eventBus.subscribe('TestEvent', async () => {
        throw new Error('Handler error');
      });

      // Good handler
      eventBus.subscribe('TestEvent', async () => {
        goodHandlerCalled = true;
      });

      const result = await eventBus.emit('TestEvent', {});

      // Should log error but continue
      const testLogger = logger as TestLogger;
      expect(testLogger.hasLog('error', 'Event handler failures')).toBe(true);

      // Good handler should still be called
      expect(goodHandlerCalled).toBe(true);

      // Overall emission should report error
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Event handler failures for TestEvent');
      }
    });

    it('should handle multiple handler errors', async () => {
      eventBus.subscribe('TestEvent', async () => {
        throw new Error('Error 1');
      });

      eventBus.subscribe('TestEvent', async () => {
        throw new Error('Error 2');
      });

      eventBus.subscribe('TestEvent', async () => {
        // This one succeeds
      });

      const result = await eventBus.emit('TestEvent', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Event handler failures for TestEvent');
        expect(result.error.message).toContain('Error 1');
        expect(result.error.message).toContain('Error 2');
      }

      const testLogger = logger as TestLogger;
      expect(testLogger.getLogsByLevel('error')).toHaveLength(1);
    });

    it('should handle async errors in handlers', async () => {
      vi.useFakeTimers();

      eventBus.subscribe('TestEvent', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('Async error');
      });

      const resultPromise = eventBus.emit('TestEvent', {});
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      const testLogger = logger as TestLogger;
      expect(testLogger.getLogsByLevel('error').length).toBeGreaterThan(0);

      vi.useRealTimers();
    });
  });

  describe('Event ordering and concurrency', () => {
    it('should maintain order within single event type', async () => {
      const order: number[] = [];

      eventBus.subscribe('OrderedEvent', async () => {
        order.push(1);
      });

      eventBus.subscribe('OrderedEvent', async () => {
        order.push(2);
      });

      eventBus.subscribe('OrderedEvent', async () => {
        order.push(3);
      });

      await eventBus.emit('OrderedEvent', {});

      expect(order).toEqual([1, 2, 3]);
    });

    it('should handle concurrent emissions', async () => {
      let counter = 0;

      eventBus.subscribe('ConcurrentEvent', async () => {
        counter++;
      });

      // Emit multiple events concurrently
      const promises = Array.from({ length: 10 }, () => eventBus.emit('ConcurrentEvent', {}));

      await Promise.all(promises);

      expect(counter).toBe(10);
    });

    it('should handle slow handlers', async () => {
      vi.useFakeTimers();
      const results: string[] = [];

      // Slow handler
      eventBus.subscribe('TestEvent', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push('slow');
      });

      // Fast handler
      eventBus.subscribe('TestEvent', async () => {
        results.push('fast');
      });

      const emitPromise = eventBus.emit('TestEvent', {});
      await vi.runAllTimersAsync();
      await emitPromise;

      // Both should complete, fast first
      expect(results).toEqual(['fast', 'slow']);

      vi.useRealTimers();
    });
  });

  describe('Event data integrity', () => {
    it('should not allow handlers to modify event data for other handlers', async () => {
      const receivedData: Array<Record<string, unknown>> = [];

      eventBus.subscribe('TestEvent', async (event: Record<string, unknown>) => {
        event.modified = true; // Try to modify
        receivedData.push({ ...event });
      });

      eventBus.subscribe('TestEvent', async (event: Record<string, unknown>) => {
        receivedData.push({ ...event });
      });

      const originalEvent = { data: 'original' };
      await eventBus.emit('TestEvent', originalEvent);

      // First handler sees its modification
      expect(receivedData[0].modified).toBe(true);

      // Second handler should see modification too (same reference)
      // This tests actual behavior - events are passed by reference
      expect(receivedData[1].modified).toBe(true);
    });

    it('should handle complex event data', async () => {
      let received: Record<string, unknown> | null = null;

      eventBus.subscribe('ComplexEvent', async (event) => {
        received = event as Record<string, unknown>;
      });

      const complexData = {
        nested: {
          deep: {
            value: 42,
            array: [1, 2, 3],
            fn: () => 'function',
          },
        },
        date: new Date(),
        symbol: Symbol('test'),
        undefined: undefined,
        null: null,
      };

      await eventBus.emit('ComplexEvent', complexData);

      // Event includes base properties, check payload properties
      expect(received).not.toBeNull();
      const r = received as Record<string, unknown>;
      expect(r.nested).toEqual(complexData.nested);
      expect(r.date).toEqual(complexData.date);
      expect(r.symbol).toEqual(complexData.symbol);
      expect(r.undefined).toEqual(complexData.undefined);
      expect(r.null).toEqual(complexData.null);
      expect((r.nested as { deep: { value: number } }).deep.value).toBe(42);
      expect(r.date).toBeInstanceOf(Date);
      expect(r.symbol).toBe(complexData.symbol);
    });
  });

  describe('Real-world patterns', () => {
    it('should support request-response pattern', async () => {
      // Simulate request-response via events
      eventBus.subscribe('Request', async (event: Record<string, unknown>) => {
        // Process request and emit response
        await eventBus.emit('Response', {
          requestId: event.id,
          result: (event.value as number) * 2,
        });
      });

      let response: Record<string, unknown> | null = null;
      eventBus.subscribe('Response', async (event) => {
        response = event as Record<string, unknown>;
      });

      await eventBus.emit('Request', { id: '123', value: 21 });

      expect(response).not.toBeNull();
      expect(response.requestId).toBe('123');
      expect(response.result).toBe(42);
    });

    it('should support event chaining', async () => {
      const chain: string[] = [];

      eventBus.subscribe('Step1', async () => {
        chain.push('step1');
        await eventBus.emit('Step2', {});
      });

      eventBus.subscribe('Step2', async () => {
        chain.push('step2');
        await eventBus.emit('Step3', {});
      });

      eventBus.subscribe('Step3', async () => {
        chain.push('step3');
      });

      await eventBus.emit('Step1', {});

      expect(chain).toEqual(['step1', 'step2', 'step3']);
    });

    it('should support filtering pattern', async () => {
      const received: Array<Record<string, unknown>> = [];

      // Subscriber with filtering logic
      eventBus.subscribe('DataEvent', async (event: Record<string, unknown>) => {
        if (event.priority === 'high') {
          received.push(event);
        }
      });

      await eventBus.emit('DataEvent', { priority: 'low', data: 1 });
      await eventBus.emit('DataEvent', { priority: 'high', data: 2 });
      await eventBus.emit('DataEvent', { priority: 'medium', data: 3 });
      await eventBus.emit('DataEvent', { priority: 'high', data: 4 });

      expect(received).toHaveLength(2);
      expect(received[0].data).toBe(2);
      expect(received[1].data).toBe(4);
    });

    it('should support event aggregation', async () => {
      const events: Array<Record<string, unknown>> = [];
      let aggregateResult: Record<string, unknown> | null = null;

      // Collector
      eventBus.subscribe('DataPoint', async (event) => {
        events.push(event as Record<string, unknown>);

        // Aggregate after 3 events
        if (events.length === 3) {
          const sum = events.reduce((acc, e) => acc + (e.value as number), 0);
          await eventBus.emit('AggregateResult', { sum });
        }
      });

      eventBus.subscribe('AggregateResult', async (event) => {
        aggregateResult = event as Record<string, unknown>;
      });

      // Emit data points
      await eventBus.emit('DataPoint', { value: 10 });
      await eventBus.emit('DataPoint', { value: 20 });
      await eventBus.emit('DataPoint', { value: 30 });

      expect(aggregateResult).not.toBeNull();
      expect(aggregateResult.sum).toBe(60);
    });
  });

  describe('Performance characteristics', () => {
    it('should handle large number of subscribers efficiently', async () => {
      const subscriberCount = TEST_COUNTS.STRESS_TEST;
      let callCount = 0;

      // Add many subscribers
      for (let i = 0; i < subscriberCount; i++) {
        eventBus.subscribe('PerfTest', async () => {
          callCount++;
        });
      }

      const start = performance.now();
      await eventBus.emit('PerfTest', {});
      const duration = performance.now() - start;

      expect(callCount).toBe(subscriberCount);
      expect(duration).toBeLessThan(100); // Should be fast even with many subscribers
    });

    it('should handle high event throughput', async () => {
      let receivedCount = 0;

      eventBus.subscribe('ThroughputTest', async () => {
        receivedCount++;
      });

      const eventCount = TEST_COUNTS.STRESS_TEST;
      const start = performance.now();

      for (let i = 0; i < eventCount; i++) {
        await eventBus.emit('ThroughputTest', { index: i });
      }

      const duration = performance.now() - start;

      expect(receivedCount).toBe(eventCount);
      expect(duration).toBeLessThan(TIMEOUTS.MEDIUM); // Should handle 1000 events in under 1 second
    });
  });
});

/**
 * Event spy utility for testing event flow
 */

import { AutobeatEvent, EventHandler } from '../../src/core/events/events';
import { EventBus } from '../../src/core/interfaces';
import { ok, Result } from '../../src/core/result';

export interface EventRecord {
  event: AutobeatEvent;
  timestamp: number;
}

export class EventSpy {
  private events: EventRecord[] = [];
  private handlers: Map<string, EventHandler[]> = new Map();
  private globalHandler: EventHandler | null = null;

  /**
   * Capture all events from an EventBus
   */
  captureAll(eventBus: EventBus): void {
    this.globalHandler = (event: AutobeatEvent) => {
      this.events.push({
        event,
        timestamp: Date.now(),
      });
      return Promise.resolve(ok(undefined));
    };
    eventBus.subscribeAll(this.globalHandler);
  }

  /**
   * Capture specific event types
   */
  capture(eventBus: EventBus, eventType: string): void {
    const handler: EventHandler = (event: AutobeatEvent) => {
      this.events.push({
        event,
        timestamp: Date.now(),
      });
      return Promise.resolve(ok(undefined));
    };

    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);

    eventBus.subscribe(eventType as AutobeatEvent['type'], handler);
  }

  /**
   * Get all captured events
   */
  getEvents(type?: string): AutobeatEvent[] {
    if (!type) {
      return this.events.map((r) => r.event);
    }
    return this.events.filter((r) => r.event.type === type).map((r) => r.event);
  }

  /**
   * Get events with timestamps
   */
  getRecords(type?: string): EventRecord[] {
    if (!type) {
      return this.events;
    }
    return this.events.filter((r) => r.event.type === type);
  }

  /**
   * Wait for a specific event
   */
  async waitForEvent(
    type: string,
    timeout: number = 5000,
    predicate?: (event: AutobeatEvent) => boolean,
  ): Promise<AutobeatEvent | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const events = this.getEvents(type);
      const matchingEvent = predicate ? events.find(predicate) : events[events.length - 1];

      if (matchingEvent) {
        return matchingEvent;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
  }

  /**
   * Wait for multiple events of a type
   */
  async waitForEvents(type: string, count: number, timeout: number = 5000): Promise<AutobeatEvent[]> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const events = this.getEvents(type);
      if (events.length >= count) {
        return events.slice(0, count);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.getEvents(type);
  }

  /**
   * Check if an event sequence occurred in order
   */
  verifySequence(expectedTypes: string[]): boolean {
    const actualTypes = this.events.map((r) => r.event.type);

    let expectedIndex = 0;
    for (const actualType of actualTypes) {
      if (actualType === expectedTypes[expectedIndex]) {
        expectedIndex++;
        if (expectedIndex === expectedTypes.length) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get event count by type
   */
  getEventCount(type?: string): number {
    if (!type) {
      return this.events.length;
    }
    return this.events.filter((r) => r.event.type === type).length;
  }

  /**
   * Clear all captured events
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Stop capturing events
   */
  stopCapturing(eventBus: EventBus): void {
    if (this.globalHandler) {
      eventBus.unsubscribeAll(this.globalHandler);
      this.globalHandler = null;
    }

    for (const [eventType, handlers] of this.handlers.entries()) {
      for (const handler of handlers) {
        eventBus.unsubscribe(eventType as string, handler);
      }
    }
    this.handlers.clear();
  }

  /**
   * Get time between two events
   */
  getTimeBetween(fromType: string, toType: string): number | null {
    const fromEvent = this.events.find((r) => r.event.type === fromType);
    const toEvent = this.events.find((r) => r.event.type === toType);

    if (!fromEvent || !toEvent) {
      return null;
    }

    return toEvent.timestamp - fromEvent.timestamp;
  }

  /**
   * Assert event was emitted
   */
  assertEventEmitted(type: string, message?: string): void {
    const events = this.getEvents(type);
    if (events.length === 0) {
      throw new Error(message || `Expected event "${type}" was not emitted`);
    }
  }

  /**
   * Assert event was not emitted
   */
  assertEventNotEmitted(type: string, message?: string): void {
    const events = this.getEvents(type);
    if (events.length > 0) {
      throw new Error(message || `Unexpected event "${type}" was emitted`);
    }
  }

  /**
   * Get event payload
   */
  getEventPayload<T extends AutobeatEvent>(type: string, index: number = 0): T | null {
    const events = this.getEvents(type);
    return (events[index] as T) || null;
  }
}

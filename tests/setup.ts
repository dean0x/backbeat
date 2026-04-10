/**
 * Global test setup and teardown hooks
 * ARCHITECTURE: Ensures proper cleanup even on test failures
 *
 * Performance Mode:
 * Set TEST_ENV=performance to disable timer wrapping for performance benchmarks
 * This prevents overhead from tracking timeouts/intervals during performance testing
 *
 * Example:
 * TEST_ENV=performance npm test -- tests/performance/
 *
 */

import { afterAll, beforeAll } from 'vitest';
import { InMemoryEventBus } from '../src/core/events/event-bus';
import type { Database } from '../src/implementations/database';

// Define types for resources that need cleanup
interface TestResources {
  eventBuses: Set<InMemoryEventBus>;
  databases: Set<Database>;
  intervals: Set<NodeJS.Timeout>;
  timeouts: Set<NodeJS.Timeout>;
}

// Track all resources that need cleanup
const activeResources: TestResources = {
  eventBuses: new Set<InMemoryEventBus>(),
  databases: new Set<Database>(),
  intervals: new Set<NodeJS.Timeout>(),
  timeouts: new Set<NodeJS.Timeout>(),
};

// Extend global type definition
declare global {
  var __testResources: TestResources;
}

// Make resources available globally for tracking
global.__testResources = activeResources;

// Only wrap timers if not in performance test mode
// This prevents overhead when measuring performance
const shouldWrapTimers = process.env.TEST_ENV !== 'performance';

// Override setTimeout to track timeouts
const originalSetTimeout = global.setTimeout;

if (shouldWrapTimers) {
  global.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timeoutId = originalSetTimeout(callback, ms, ...args);
    activeResources.timeouts.add(timeoutId);

    // Wrap callback to remove from tracking when executed
    const wrappedCallback = () => {
      activeResources.timeouts.delete(timeoutId);
      callback(...args);
    };

    return originalSetTimeout(wrappedCallback, ms);
  }) as typeof setTimeout;
} else {
  // In performance mode, keep original implementation
  global.setTimeout = originalSetTimeout;
}

// Override setInterval to track intervals
const originalSetInterval = global.setInterval;

if (shouldWrapTimers) {
  global.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const intervalId = originalSetInterval(callback, ms, ...args);
    activeResources.intervals.add(intervalId);
    return intervalId;
  }) as typeof setInterval;
} else {
  // In performance mode, keep original implementation
  global.setInterval = originalSetInterval;
}

// Override clearTimeout to remove from tracking
const originalClearTimeout = global.clearTimeout;

if (shouldWrapTimers) {
  global.clearTimeout = ((timeoutId: NodeJS.Timeout) => {
    activeResources.timeouts.delete(timeoutId);
    return originalClearTimeout(timeoutId);
  }) as typeof clearTimeout;
} else {
  global.clearTimeout = originalClearTimeout;
}

// Override clearInterval to remove from tracking
const originalClearInterval = global.clearInterval;

if (shouldWrapTimers) {
  global.clearInterval = ((intervalId: NodeJS.Timeout) => {
    activeResources.intervals.delete(intervalId);
    return originalClearInterval(intervalId);
  }) as typeof clearInterval;
} else {
  global.clearInterval = originalClearInterval;
}

beforeAll(() => {
  // Set lower memory limits for tests
  if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--max-old-space-size')) {
    process.env.NODE_OPTIONS += ' --max-old-space-size=2048';
  } else if (!process.env.NODE_OPTIONS) {
    process.env.NODE_OPTIONS = '--max-old-space-size=2048';
  }
});

afterAll(() => {
  const cleanupErrors: Error[] = [];

  // Clear all timeouts
  for (const timeoutId of activeResources.timeouts) {
    try {
      originalClearTimeout(timeoutId);
    } catch (error) {
      cleanupErrors.push(new Error(`Failed to clear timeout: ${error}`));
    }
  }
  activeResources.timeouts.clear();

  // Clear all intervals
  for (const intervalId of activeResources.intervals) {
    try {
      originalClearInterval(intervalId);
    } catch (error) {
      cleanupErrors.push(new Error(`Failed to clear interval: ${error}`));
    }
  }
  activeResources.intervals.clear();

  // Dispose all EventBuses
  for (const eventBus of activeResources.eventBuses) {
    try {
      eventBus.dispose();
    } catch (error) {
      cleanupErrors.push(new Error(`Failed to dispose EventBus: ${error}`));
      console.error('Failed to dispose EventBus:', error);
    }
  }
  activeResources.eventBuses.clear();

  // Close all databases
  for (const database of activeResources.databases) {
    try {
      if (database.close) {
        database.close();
      }
    } catch (error) {
      cleanupErrors.push(new Error(`Failed to close database: ${error}`));
      console.error('Failed to close database:', error);
    }
  }
  activeResources.databases.clear();

  // Force garbage collection if available
  if (global.gc) {
    try {
      global.gc();
    } catch (error) {
      cleanupErrors.push(new Error(`Failed to run garbage collection: ${error}`));
    }
  }

  // Report aggregated errors
  if (cleanupErrors.length > 0) {
    console.error(`Test cleanup encountered ${cleanupErrors.length} error(s):`);
    cleanupErrors.forEach((error, index) => {
      console.error(`  ${index + 1}. ${error.message}`);
    });
    // Don't throw in afterAll as it can cause confusing test failures
    // Just ensure errors are visible in the output
  }
});

// Export helper to register resources for cleanup
export function registerForCleanup(resource: InMemoryEventBus | Database, type: 'eventBus' | 'database'): void {
  switch (type) {
    case 'eventBus':
      activeResources.eventBuses.add(resource as InMemoryEventBus);
      break;
    case 'database':
      activeResources.databases.add(resource as Database);
      break;
  }
}

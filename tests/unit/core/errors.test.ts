import { describe, expect, it } from 'vitest';
import {
  BackbeatError,
  ErrorCode,
  insufficientResources,
  invalidDirectory,
  invalidInput,
  isBackbeatError,
  processSpawnFailed,
  systemError,
  taskAlreadyRunning,
  taskNotFound,
  taskTimeout,
  toBackbeatError,
} from '../../../src/core/errors';
import { TEST_COUNTS, TIMEOUTS } from '../../constants';

describe('BackbeatError - REAL Error Behavior', () => {
  describe('Error creation and properties', () => {
    it('should create error with code and message', () => {
      const error = new BackbeatError(ErrorCode.TASK_NOT_FOUND, 'Task task-123 not found');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(BackbeatError);
      expect(error.code).toBe(ErrorCode.TASK_NOT_FOUND);
      expect(error.message).toBe('Task task-123 not found');
      expect(error.name).toBe('BackbeatError');

      // Additional error property validations
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
      expect(typeof error.name).toBe('string');
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
      expect(error.context).toBeUndefined();
      expect(error.toString()).toContain('BackbeatError');
      expect(error.toString()).toContain('Task task-123 not found');
    });

    it('should include context', () => {
      const error = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Connection failed', { host: 'localhost', port: 5432 });

      expect(error.context).toEqual({ host: 'localhost', port: 5432 });

      // Additional context validations
      expect(error.code).toBe(ErrorCode.SYSTEM_ERROR);
      expect(error.message).toBe('Connection failed');
      expect(error.name).toBe('BackbeatError');
      expect(typeof error.context).toBe('object');
      expect(error.context).not.toBeNull();
      expect(Object.keys(error.context)).toEqual(['host', 'port']);
      expect(error.context.host).toBe('localhost');
      expect(error.context.port).toBe(5432);
    });

    it('should preserve stack trace', () => {
      const error = new BackbeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Failed to spawn process');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('BackbeatError');
      expect(error.stack).toContain('errors.test.ts');
    });

    it('should include error in context', () => {
      const cause = new Error('Original error');
      const error = new BackbeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Process spawn failed', {
        originalError: cause.message,
      });

      expect(error.context?.originalError).toBe('Original error');
    });
  });

  describe('Error factory functions', () => {
    it('should create task not found error', () => {
      const error = taskNotFound('task-456');

      expect(error.code).toBe(ErrorCode.TASK_NOT_FOUND);
      expect(error.message).toBe('Task task-456 not found');
      expect(isBackbeatError(error)).toBe(true);
    });

    it('should create task already running error', () => {
      const error = taskAlreadyRunning('task-789');

      expect(error.code).toBe(ErrorCode.TASK_ALREADY_RUNNING);
      expect(error.message).toBe('Task task-789 is already running');
    });

    it('should create task timeout error', () => {
      const error = taskTimeout('task-123', 30000);

      expect(error.code).toBe(ErrorCode.TASK_TIMEOUT);
      expect(error.message).toBe('Task task-123 timed out after 30000ms');
    });

    it('should create insufficient resources error', () => {
      const error = insufficientResources(95, 100000000);

      expect(error.code).toBe(ErrorCode.INSUFFICIENT_RESOURCES);
      expect(error.message).toContain('Insufficient resources');
    });

    it('should create invalid input error', () => {
      const error = invalidInput('path', '../etc/passwd');

      expect(error.code).toBe(ErrorCode.INVALID_INPUT);
      expect(error.message).toBe('Invalid input for field path');
    });

    it('should create invalid directory error', () => {
      const error = invalidDirectory('/invalid/path');

      expect(error.code).toBe(ErrorCode.INVALID_DIRECTORY);
      expect(error.message).toBe('Invalid directory: /invalid/path');
    });

    it('should create system error', () => {
      const error = systemError('Unexpected failure');

      expect(error.code).toBe(ErrorCode.SYSTEM_ERROR);
      expect(error.message).toBe('Unexpected failure');
    });

    it('should create process spawn failed error', () => {
      const error = processSpawnFailed('Command not found');

      expect(error.code).toBe(ErrorCode.PROCESS_SPAWN_FAILED);
      expect(error.message).toBe('Failed to spawn process: Command not found');
    });

    it('should create system error with original error', () => {
      const originalError = new Error('Original');
      const error = systemError('Wrapped error', originalError);

      expect(error.code).toBe(ErrorCode.SYSTEM_ERROR);
      expect(error.message).toBe('Wrapped error');
      expect(error.context).toEqual({ originalError: 'Original' });
    });
  });

  describe('Error type guards and helpers', () => {
    it('should identify BackbeatError instances', () => {
      const delegateError = new BackbeatError(ErrorCode.TASK_NOT_FOUND, 'Not found');
      const regularError = new Error('Regular error');
      const typeError = new TypeError('Type error');

      expect(isBackbeatError(delegateError)).toBe(true);
      expect(isBackbeatError(regularError)).toBe(false);
      expect(isBackbeatError(typeError)).toBe(false);
      expect(isBackbeatError(null)).toBe(false);
      expect(isBackbeatError(undefined)).toBe(false);
      expect(isBackbeatError('string')).toBe(false);
    });

    it('should access error code from BackbeatError', () => {
      const error = taskNotFound('task-123');
      expect(error.code).toBe(ErrorCode.TASK_NOT_FOUND);
    });

    it('should have correct error codes for different errors', () => {
      expect(taskAlreadyRunning('task').code).toBe(ErrorCode.TASK_ALREADY_RUNNING);
      expect(processSpawnFailed('reason').code).toBe(ErrorCode.PROCESS_SPAWN_FAILED);
      expect(invalidInput('field', 'value').code).toBe(ErrorCode.INVALID_INPUT);
    });

    it('should have meaningful error messages', () => {
      const delegateError = taskNotFound('task-123');
      const timeoutError = taskTimeout('task-456', TIMEOUTS.LONG);
      const resourceError = insufficientResources(95, 1000000);

      expect(delegateError.message).toBe('Task task-123 not found');
      expect(timeoutError.message).toBe('Task task-456 timed out after 5000ms');
      expect(resourceError.message).toContain('Insufficient resources');
    });

    it('should convert various types to BackbeatError', () => {
      // Regular Error
      const regularError = new Error('Regular');
      const converted1 = toBackbeatError(regularError);
      expect(converted1).toBeInstanceOf(BackbeatError);
      expect(converted1.code).toBe(ErrorCode.SYSTEM_ERROR);
      expect(converted1.message).toBe('Regular');

      // Already BackbeatError
      const delegateError = taskNotFound('task');
      const converted2 = toBackbeatError(delegateError);
      expect(converted2).toBe(delegateError); // Should return same instance

      // String
      const converted3 = toBackbeatError('String error');
      expect(converted3).toBeInstanceOf(BackbeatError);
      expect(converted3.message).toBe('String error');

      // Object with message
      const converted4 = toBackbeatError({ message: 'Object error', code: 'TEST' });
      expect(converted4.message).toBe('Object error');

      // Number
      const converted5 = toBackbeatError(404);
      expect(converted5.message).toBe('404');

      // Null/undefined
      const converted6 = toBackbeatError(null);
      expect(converted6.message).toBe('Unknown error');
    });
  });

  describe('Error code organization', () => {
    it('should have unique error codes', () => {
      const codes = Object.values(ErrorCode);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });

    it('should group error codes by category', () => {
      // Task errors
      expect(ErrorCode.TASK_NOT_FOUND).toContain('TASK');
      expect(ErrorCode.TASK_ALREADY_RUNNING).toContain('TASK');
      expect(ErrorCode.TASK_TIMEOUT).toContain('TASK');

      // Resource errors
      expect(ErrorCode.INSUFFICIENT_RESOURCES).toContain('RESOURCE');

      // Process errors
      expect(ErrorCode.PROCESS_SPAWN_FAILED).toContain('PROCESS');
      expect(ErrorCode.PROCESS_NOT_FOUND).toContain('PROCESS');

      // Validation errors
      expect(ErrorCode.INVALID_INPUT).toContain('INVALID');
      expect(ErrorCode.INVALID_DIRECTORY).toContain('INVALID');

      // System errors
      expect(ErrorCode.SYSTEM_ERROR).toContain('SYSTEM');
    });
  });

  describe('Error serialization', () => {
    it('should serialize to JSON correctly', () => {
      const error = new BackbeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {
        taskId: 'task-123',
        attempts: 3,
      });

      const json = JSON.stringify(error);
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe('BackbeatError');
      expect(parsed.message).toBe('Spawn failed');
      expect(parsed.code).toBe(ErrorCode.PROCESS_SPAWN_FAILED);
      expect(parsed.context).toEqual({ taskId: 'task-123', attempts: 3 });
    });

    it('should handle circular references in context', () => {
      const context: Record<string, unknown> = { key: 'value' };
      context.circular = context;

      const error = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'System error', context);

      // Should not throw when accessing context
      expect(error.context?.key).toBe('value');
      expect(error.context?.circular).toBe(context);
    });
  });

  describe('Error comparison and equality', () => {
    it('should compare errors by code', () => {
      const error1 = taskNotFound('task-1');
      const error2 = taskNotFound('task-2');
      const error3 = processSpawnFailed('reason');

      expect(error1.code).toBe(error2.code);
      expect(error1.code).not.toBe(error3.code);
    });

    it('should maintain instanceof across errors', () => {
      const errors = [
        taskNotFound('task'),
        taskAlreadyRunning('task'),
        processSpawnFailed('reason'),
        systemError('failure'),
      ];

      errors.forEach((error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(BackbeatError);
      });
    });
  });

  describe('Real-world error patterns', () => {
    it('should chain errors with context', () => {
      const originalError = new Error('SQLITE_BUSY: database is locked');
      const appError = systemError(originalError.message, originalError);

      const finalError = new BackbeatError(ErrorCode.TASK_NOT_FOUND, 'Could not fetch task', { taskId: 'task-123' });

      expect(finalError.context?.taskId).toBe('task-123');
      expect(finalError.message).toBe('Could not fetch task');
    });

    it('should handle async error contexts', async () => {
      const asyncOperation = async () => {
        throw processSpawnFailed('Command not found: claude');
      };

      try {
        await asyncOperation();
      } catch (error) {
        expect(isBackbeatError(error)).toBe(true);
        if (isBackbeatError(error)) {
          expect(error.code).toBe(ErrorCode.PROCESS_SPAWN_FAILED);
        }
      }
    });

    it('should work with Result type patterns', () => {
      type Result<T> = { ok: true; value: T } | { ok: false; error: BackbeatError };

      const success: Result<string> = { ok: true, value: 'data' };
      const failure: Result<string> = {
        ok: false,
        error: taskNotFound('task-404'),
      };

      if (!failure.ok) {
        expect(failure.error.code).toBe(ErrorCode.TASK_NOT_FOUND);
      }

      if (success.ok) {
        expect(success.value).toBe('data');
      }
    });

    it('should handle error recovery strategies', () => {
      const tryOperation = (attempt: number): BackbeatError | null => {
        if (attempt < 3) {
          return taskTimeout('operation', TIMEOUTS.LONG);
        }
        return null; // Success
      };

      const errors: BackbeatError[] = [];

      for (let i = 1; i <= 5; i++) {
        const error = tryOperation(i);
        if (error) {
          errors.push(error);
        } else {
          break;
        }
      }

      expect(errors).toHaveLength(2);
      expect(errors.every((e) => e.code === ErrorCode.TASK_TIMEOUT)).toBe(true);
    });
  });

  describe('Performance characteristics', () => {
    it('should create errors efficiently', () => {
      const count = TEST_COUNTS.STRESS_TEST * 5; // REDUCED: From 10k to 5k to prevent memory pressure
      const start = performance.now();

      const errors = [];
      // Create in batches to allow GC to run
      const batchSize = 500;
      for (let i = 0; i < count; i += batchSize) {
        const batch = Array.from({ length: Math.min(batchSize, count - i) }, (_, j) => taskNotFound(`task-${i + j}`));
        errors.push(...batch);
      }

      const duration = performance.now() - start;

      expect(errors).toHaveLength(count);
      expect(duration).toBeLessThan(120); // Should create 5k errors in < 120ms
    });

    it('should handle deep error chains', () => {
      let error: Error = new Error('Root cause');

      // Create deep chain by wrapping errors in context
      for (let i = 0; i < 100; i++) {
        error = new BackbeatError(ErrorCode.SYSTEM_ERROR, `Layer ${i}: ${error.message}`, {
          previousError: error.message,
          layer: i,
        });
      }

      // Should handle deep chain without stack overflow
      expect(error).toBeInstanceOf(BackbeatError);
      expect(error.message).toContain('Layer 99');
      expect(error.message).toContain('Root cause');

      // Verify context preserved
      if (isBackbeatError(error)) {
        expect(error.context?.layer).toBe(99);
      }
    });
  });
});

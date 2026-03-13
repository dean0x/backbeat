/**
 * SQLite-based dependency repository implementation
 * ARCHITECTURE: Pure Result pattern for all operations, pure data access layer
 * Pattern: Repository pattern with prepared statements for performance
 * Rationale: Efficient dependency persistence without business logic (DAG validation in handler)
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { TaskId } from '../core/domain.js';
import { BackbeatError, ErrorCode, operationErrorHandler } from '../core/errors.js';
import { DependencyRepository, TaskDependency } from '../core/interfaces.js';
import { err, ok, Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

/**
 * Zod schema for validating dependency rows from database
 * Pattern: Parse, don't validate - ensures type safety at system boundary
 */
const DependencyRowSchema = z.object({
  id: z.number(),
  task_id: z.string().min(1),
  depends_on_task_id: z.string().min(1),
  created_at: z.number(),
  resolved_at: z.number().nullable(),
  resolution: z.enum(['pending', 'completed', 'failed', 'cancelled']),
});

/**
 * Database row type for task_dependencies table
 * TYPE-SAFETY: Explicit typing instead of Record<string, any>
 */
interface DependencyRow {
  readonly id: number;
  readonly task_id: string;
  readonly depends_on_task_id: string;
  readonly created_at: number;
  readonly resolved_at: number | null;
  readonly resolution: string;
}

export class SQLiteDependencyRepository implements DependencyRepository {
  // SECURITY: Hard limits to prevent DoS attacks and stack overflow
  private static readonly MAX_DEPENDENCIES_PER_TASK = 100;
  // NOTE: MAX_DEPENDENCY_CHAIN_DEPTH moved to DependencyHandler (see line 24)

  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  private readonly database: Database;
  private readonly db: SQLite.Database;
  private readonly addDependencyStmt: SQLite.Statement;
  private readonly getDependenciesStmt: SQLite.Statement;
  private readonly getDependentsStmt: SQLite.Statement;
  private readonly resolveDependencyStmt: SQLite.Statement;
  private readonly resolveDependenciesBatchStmt: SQLite.Statement;
  private readonly getUnresolvedDependenciesStmt: SQLite.Statement;
  private readonly isBlockedStmt: SQLite.Statement;
  private readonly findAllUnboundedStmt: SQLite.Statement;
  private readonly deleteDependenciesStmt: SQLite.Statement;
  private readonly checkDependencyExistsStmt: SQLite.Statement;
  private readonly getDependencyByIdStmt: SQLite.Statement;
  private readonly checkTaskExistsStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly findAllPaginatedStmt: SQLite.Statement;

  constructor(database: Database) {
    this.database = database;
    this.db = database.getDatabase();

    // Prepare statements for better performance
    this.addDependencyStmt = this.db.prepare(`
      INSERT INTO task_dependencies (
        task_id, depends_on_task_id, created_at, resolution
      ) VALUES (?, ?, ?, 'pending')
    `);

    this.getDependenciesStmt = this.db.prepare(`
      SELECT * FROM task_dependencies WHERE task_id = ?
    `);

    this.getDependentsStmt = this.db.prepare(`
      SELECT * FROM task_dependencies WHERE depends_on_task_id = ?
    `);

    this.resolveDependencyStmt = this.db.prepare(`
      UPDATE task_dependencies
      SET resolution = ?, resolved_at = ?
      WHERE task_id = ? AND depends_on_task_id = ?
    `);

    this.resolveDependenciesBatchStmt = this.db.prepare(`
      UPDATE task_dependencies
      SET resolution = ?, resolved_at = ?
      WHERE depends_on_task_id = ? AND resolution = 'pending'
    `);

    this.getUnresolvedDependenciesStmt = this.db.prepare(`
      SELECT * FROM task_dependencies
      WHERE task_id = ? AND resolution = 'pending'
    `);

    this.isBlockedStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM task_dependencies
      WHERE task_id = ? AND resolution = 'pending'
    `);

    this.findAllUnboundedStmt = this.db.prepare(`
      SELECT * FROM task_dependencies ORDER BY created_at DESC
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM task_dependencies
    `);

    this.findAllPaginatedStmt = this.db.prepare(`
      SELECT * FROM task_dependencies ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.deleteDependenciesStmt = this.db.prepare(`
      DELETE FROM task_dependencies
      WHERE task_id = ? OR depends_on_task_id = ?
    `);

    this.checkDependencyExistsStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM task_dependencies
      WHERE task_id = ? AND depends_on_task_id = ?
    `);

    this.getDependencyByIdStmt = this.db.prepare(`
      SELECT * FROM task_dependencies WHERE id = ?
    `);

    this.checkTaskExistsStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE id = ?
    `);
  }

  /**
   * Add a dependency relationship between two tasks
   *
   * ARCHITECTURE: Pure data access layer - no business logic (cycle detection in handler)
   * Uses synchronous better-sqlite3 transaction to prevent TOCTOU race conditions.
   *
   * @param taskId - The task that depends on another task
   * @param dependsOnTaskId - The task to depend on
   * @returns Result containing created TaskDependency or error if:
   *   - Dependency already exists (ErrorCode.INVALID_OPERATION)
   *   - Either task doesn't exist (ErrorCode.TASK_NOT_FOUND)
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.addDependency(taskB.id, taskA.id);
   * if (!result.ok) {
   *   console.error('Failed to add dependency:', result.error.message);
   * }
   * ```
   */
  async addDependency(taskId: TaskId, dependsOnTaskId: TaskId): Promise<Result<TaskDependency>> {
    // REFACTOR: Delegate to addDependencies() to eliminate duplicate validation logic
    // This centralizes all validation (task existence, cycle detection, depth check, etc.)
    // in a single location, improving maintainability and consistency
    const batchResult = await this.addDependencies(taskId, [dependsOnTaskId]);

    if (!batchResult.ok) {
      return batchResult;
    }

    // Extract the single dependency from the batch result
    return ok(batchResult.value[0]);
  }

  /**
   * Add multiple dependencies atomically in a single transaction
   *
   * ARCHITECTURE: Pure data access layer - no business logic (cycle detection in handler)
   * Uses synchronous better-sqlite3 transaction for atomicity.
   * All dependencies succeed or all fail together (no partial state).
   *
   * @param taskId - The task that depends on other tasks
   * @param dependsOn - Array of task IDs to depend on
   * @returns Result containing array of created TaskDependency objects or error if:
   *   - Any dependency already exists (ErrorCode.INVALID_OPERATION)
   *   - Any task doesn't exist (ErrorCode.TASK_NOT_FOUND)
   *   - Empty array provided (ErrorCode.INVALID_OPERATION)
   *   - Too many dependencies (ErrorCode.INVALID_OPERATION)
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.addDependencies(taskC.id, [taskA.id, taskB.id]);
   * if (!result.ok) {
   *   console.error('Failed to add dependencies:', result.error.message);
   * } else {
   *   console.log(`Added ${result.value.length} dependencies atomically`);
   * }
   * ```
   */
  async addDependencies(taskId: TaskId, dependsOn: readonly TaskId[]): Promise<Result<readonly TaskDependency[]>> {
    // VALIDATION: Reject empty arrays
    if (dependsOn.length === 0) {
      return err(new BackbeatError(ErrorCode.INVALID_OPERATION, 'Cannot add dependencies: empty array provided'));
    }

    // SECURITY: Prevent DoS attacks with excessive dependencies
    // Limit to MAX_DEPENDENCIES_PER_TASK for reasonable production workflows
    if (dependsOn.length > SQLiteDependencyRepository.MAX_DEPENDENCIES_PER_TASK) {
      return err(
        new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Cannot add ${dependsOn.length} dependencies: task cannot have more than ${SQLiteDependencyRepository.MAX_DEPENDENCIES_PER_TASK} dependencies`,
        ),
      );
    }

    // SECURITY: TOCTOU Fix - Use runInTransaction() for true atomicity
    // All validation and insertion happens within single atomic transaction
    return this.database.runInTransaction(() => {
      // ALL operations below are synchronous - no await, no yielding to event loop

      // VALIDATION: Check dependent task exists
      const taskExistsResult = this.checkTaskExistsStmt.get(taskId) as { count: number };
      if (taskExistsResult.count === 0) {
        throw new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Task not found: ${taskId}`);
      }

      // SECURITY: Check current dependency count to prevent exceeding MAX_DEPENDENCIES_PER_TASK total
      const existingDepsCount = (this.getDependenciesStmt.all(taskId) as DependencyRow[]).length;
      if (existingDepsCount + dependsOn.length > SQLiteDependencyRepository.MAX_DEPENDENCIES_PER_TASK) {
        throw new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Cannot add ${dependsOn.length} dependencies: task would exceed maximum of ${SQLiteDependencyRepository.MAX_DEPENDENCIES_PER_TASK} dependencies (currently has ${existingDepsCount})`,
        );
      }

      // VALIDATION: Check all dependency targets exist
      for (const depId of dependsOn) {
        const depExistsResult = this.checkTaskExistsStmt.get(depId) as { count: number };
        if (depExistsResult.count === 0) {
          throw new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Task not found: ${depId}`);
        }
      }

      // VALIDATION: Check for existing dependencies
      for (const depId of dependsOn) {
        const existsResult = this.checkDependencyExistsStmt.get(taskId, depId) as { count: number };
        if (existsResult.count > 0) {
          throw new BackbeatError(
            ErrorCode.INVALID_OPERATION,
            `Dependency already exists: ${taskId} depends on ${depId}`,
          );
        }
      }

      // NOTE: Cycle detection and depth checking moved to DependencyHandler
      // ARCHITECTURE: Business logic (DAG validation) now in handler layer
      // Repository is pure data access layer - see DependencyHandler.handleTaskDelegated()

      // All validations passed - insert all dependencies atomically
      const createdAt = Date.now();
      const createdDependencies: TaskDependency[] = [];

      for (const depId of dependsOn) {
        const result = this.addDependencyStmt.run(taskId, depId, createdAt);
        const row = this.getDependencyByIdStmt.get(result.lastInsertRowid) as DependencyRow;
        createdDependencies.push(this.rowToDependency(row));
      }

      return createdDependencies;
    });
  }

  /**
   * Get all dependencies for a task (tasks that this task depends on)
   *
   * Returns only direct dependencies, not transitive closure.
   * Use DependencyGraph.getAllDependencies() for transitive dependencies.
   *
   * @param taskId - The task to get dependencies for
   * @returns Result containing array of TaskDependency objects or error
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.getDependencies(taskA.id);
   * if (result.ok) {
   *   console.log(`Task A depends on ${result.value.length} tasks`);
   * }
   * ```
   */
  async getDependencies(taskId: TaskId): Promise<Result<readonly TaskDependency[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.getDependenciesStmt.all(taskId) as DependencyRow[];
        return rows.map((row) => this.rowToDependency(row));
      },
      operationErrorHandler('get dependencies', { taskId }),
    );
  }

  /**
   * Get all dependents for a task (tasks that depend on this task)
   *
   * Returns only direct dependents, not transitive closure.
   * Use DependencyGraph.getAllDependents() for transitive dependents.
   *
   * @param taskId - The task to get dependents for
   * @returns Result containing array of TaskDependency objects or error
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.getDependents(taskA.id);
   * if (result.ok) {
   *   console.log(`${result.value.length} tasks depend on Task A`);
   * }
   * ```
   */
  async getDependents(taskId: TaskId): Promise<Result<readonly TaskDependency[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.getDependentsStmt.all(taskId) as DependencyRow[];
        return rows.map((row) => this.rowToDependency(row));
      },
      operationErrorHandler('get dependents', { taskId }),
    );
  }

  /**
   * Mark a dependency as resolved with the given resolution state
   *
   * Called when a dependency completes, fails, or is cancelled.
   * Updates the resolution and resolved_at timestamp.
   *
   * @param taskId - The task that has the dependency
   * @param dependsOnTaskId - The dependency task that was resolved
   * @param resolution - The resolution state: 'completed', 'failed', or 'cancelled'
   * @returns Result indicating success or error if dependency not found
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.resolveDependency(
   *   taskB.id,
   *   taskA.id,
   *   'completed'
   * );
   * if (result.ok) {
   *   console.log('Dependency marked as completed');
   * }
   * ```
   */
  async resolveDependency(
    taskId: TaskId,
    dependsOnTaskId: TaskId,
    resolution: 'completed' | 'failed' | 'cancelled',
  ): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        const resolvedAt = Date.now();
        const result = this.resolveDependencyStmt.run(resolution, resolvedAt, taskId, dependsOnTaskId);

        if (result.changes === 0) {
          throw new BackbeatError(
            ErrorCode.TASK_NOT_FOUND,
            `Dependency not found: ${taskId} depends on ${dependsOnTaskId}`,
          );
        }
      },
      operationErrorHandler('resolve dependency', { taskId, dependsOnTaskId, resolution }),
    );
  }

  /**
   * Batch resolve all dependencies that depend on a completed task
   *
   * PERFORMANCE: Single UPDATE query replaces N+1 queries (7-10× faster).
   * Updates all pending dependencies for a given task in one atomic operation.
   *
   * @param dependsOnTaskId - The task that completed/failed/cancelled
   * @param resolution - The resolution state: 'completed', 'failed', or 'cancelled'
   * @returns Result containing count of dependencies resolved
   *
   * @example
   * ```typescript
   * // Task A completes, resolve all 20 tasks waiting on it in ONE query
   * const result = await dependencyRepo.resolveDependenciesBatch(
   *   taskA.id,
   *   'completed'
   * );
   * if (result.ok) {
   *   console.log(`Resolved ${result.value} dependencies in single query`);
   * }
   * ```
   */
  async resolveDependenciesBatch(
    dependsOnTaskId: TaskId,
    resolution: 'completed' | 'failed' | 'cancelled',
  ): Promise<Result<number>> {
    return tryCatchAsync(
      async () => {
        const resolvedAt = Date.now();
        const result = this.resolveDependenciesBatchStmt.run(resolution, resolvedAt, dependsOnTaskId);
        return result.changes;
      },
      operationErrorHandler('batch resolve dependencies', { dependsOnTaskId, resolution }),
    );
  }

  /**
   * Get all unresolved (pending) dependencies for a task
   *
   * Returns only dependencies with resolution='pending'.
   * Used to check if a task is still blocked waiting for dependencies.
   *
   * @param taskId - The task to get unresolved dependencies for
   * @returns Result containing array of pending TaskDependency objects or error
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.getUnresolvedDependencies(taskB.id);
   * if (result.ok && result.value.length === 0) {
   *   console.log('Task B has no pending dependencies - ready to run');
   * }
   * ```
   */
  async getUnresolvedDependencies(taskId: TaskId): Promise<Result<readonly TaskDependency[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.getUnresolvedDependenciesStmt.all(taskId) as DependencyRow[];
        return rows.map((row) => this.rowToDependency(row));
      },
      operationErrorHandler('get unresolved dependencies', { taskId }),
    );
  }

  /**
   * Check if a task is blocked by unresolved dependencies
   *
   * Returns true if the task has any dependencies with resolution='pending'.
   * Used by QueueHandler to determine if task can be enqueued.
   *
   * @param taskId - The task to check for blocking dependencies
   * @returns Result containing true if task is blocked, false if ready to run
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.isBlocked(taskB.id);
   * if (result.ok && !result.value) {
   *   // Task is not blocked - can be enqueued
   *   await queue.enqueue(taskB);
   * }
   * ```
   */
  async isBlocked(taskId: TaskId): Promise<Result<boolean>> {
    return tryCatchAsync(
      async () => {
        const result = this.isBlockedStmt.get(taskId) as { count: number };
        return result.count > 0;
      },
      operationErrorHandler('check if task is blocked', { taskId }),
    );
  }

  /**
   * Get dependencies with pagination
   *
   * Returns TaskDependency records ordered by created_at DESC with pagination.
   * Default limit is 100 records per page.
   *
   * For complete dependency graph construction, use findAllUnbounded() instead.
   *
   * @param limit Maximum results to return (default: 100)
   * @param offset Number of records to skip (default: 0)
   * @returns Result containing paginated array of TaskDependency objects or error
   *
   * @example
   * ```typescript
   * // Get first page (100 records)
   * const page1 = await dependencyRepo.findAll();
   *
   * // Get second page
   * const page2 = await dependencyRepo.findAll(100, 100);
   *
   * // Get all dependencies (no pagination)
   * const all = await dependencyRepo.findAllUnbounded();
   * ```
   */
  async findAll(limit?: number, offset?: number): Promise<Result<readonly TaskDependency[]>> {
    return tryCatchAsync(async () => {
      const effectiveLimit = limit ?? SQLiteDependencyRepository.DEFAULT_LIMIT;
      const effectiveOffset = offset ?? 0;

      const rows = this.findAllPaginatedStmt.all(effectiveLimit, effectiveOffset) as DependencyRow[];
      return rows.map((row) => this.rowToDependency(row));
    }, operationErrorHandler('find all dependencies'));
  }

  /**
   * Get all dependencies without pagination limit
   *
   * ARCHITECTURE: Use only for graph initialization (DependencyHandler.create())
   * For user queries, use findAll() with pagination instead.
   *
   * This is a full table scan - use sparingly in production.
   *
   * @returns All dependencies ordered by created_at DESC
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.findAllUnbounded();
   * if (result.ok) {
   *   const graph = new DependencyGraph(result.value);
   *   console.log(`System has ${result.value.length} total dependencies`);
   * }
   * ```
   */
  async findAllUnbounded(): Promise<Result<readonly TaskDependency[]>> {
    return tryCatchAsync(async () => {
      const rows = this.findAllUnboundedStmt.all() as DependencyRow[];
      return rows.map((row) => this.rowToDependency(row));
    }, operationErrorHandler('find all dependencies (unbounded)'));
  }

  /**
   * Count total dependencies in repository
   *
   * Useful for pagination UI to display total pages.
   *
   * @returns Total dependency count
   *
   * @example
   * ```typescript
   * const countResult = await dependencyRepo.count();
   * const allResult = await dependencyRepo.findAll(100, 0);
   * if (countResult.ok && allResult.ok) {
   *   console.log(`Showing ${allResult.value.length} of ${countResult.value} dependencies`);
   * }
   * ```
   */
  async count(): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const result = this.countStmt.get() as { count: number };
      return result.count;
    }, operationErrorHandler('count dependencies'));
  }

  /**
   * Delete all dependencies related to a task
   *
   * Removes all dependency records where the task is either:
   * - The dependent task (task_id = taskId), or
   * - The dependency target (depends_on_task_id = taskId)
   *
   * Called when a task is cancelled or deleted to clean up orphaned dependencies.
   * Invalidates dependency graph cache after deletion.
   *
   * @param taskId - The task to delete all dependencies for
   * @returns Result indicating success or error
   *
   * @example
   * ```typescript
   * const result = await dependencyRepo.deleteDependencies(taskA.id);
   * if (result.ok) {
   *   console.log('All dependencies for Task A removed');
   * }
   * ```
   */
  async deleteDependencies(taskId: TaskId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        // Delete from database (removes edges, NOT the task node itself)
        this.deleteDependenciesStmt.run(taskId, taskId);

        // NOTE: Graph updates removed
        // ARCHITECTURE: DependencyHandler now owns graph and handles updates via events
      },
      operationErrorHandler('delete dependencies', { taskId }),
    );
  }

  /**
   * Convert database row to TaskDependency domain object
   * Pattern: Validate at boundary - ensures data integrity from database
   * @throws Error if row data is invalid (indicates database corruption)
   */
  private rowToDependency(row: DependencyRow): TaskDependency {
    // Validate row data at system boundary (parse throws ZodError on invalid data)
    // This catches database corruption or schema mismatches early
    const data = DependencyRowSchema.parse(row);
    return {
      id: data.id,
      taskId: data.task_id as TaskId,
      dependsOnTaskId: data.depends_on_task_id as TaskId,
      createdAt: data.created_at,
      resolvedAt: data.resolved_at,
      resolution: data.resolution,
    };
  }
}

/**
 * Input validation utilities
 * Provides secure validation for user inputs
 */

import fs from 'fs';
import path from 'path';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { err, ok, Result } from '../core/result.js';

/**
 * Validate that a path is within allowed boundaries
 * SECURITY: Uses fs.realpathSync() to resolve symlinks and prevent path traversal
 * Prevents attacks like:
 * - Path traversal: ../../etc/passwd
 * - Symlink attacks: link -> /etc/passwd
 * - Unicode attacks: ..%2F..%2Fetc%2Fpasswd
 *
 * @param inputPath The path to validate
 * @param baseDir Base directory to validate against (defaults to cwd)
 * @param mustExist If true, path must exist on filesystem (default: false)
 * @returns Resolved absolute path or error if validation fails
 */
export function validatePath(inputPath: string, baseDir?: string, mustExist = false): Result<string> {
  try {
    // If no base directory provided, use current working directory
    const base = baseDir || process.cwd();

    // SECURITY: Resolve the real filesystem path including symlinks
    // This prevents symlink-based path traversal attacks
    let resolvedBase: string;
    try {
      resolvedBase = fs.realpathSync(base);
    } catch (error) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Base directory does not exist: ${base}`));
    }

    // First resolve relative path
    const absolutePath = path.resolve(base, inputPath);

    // Check if path exists (optional)
    if (mustExist && !fs.existsSync(absolutePath)) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Path does not exist: ${inputPath}`));
    }

    // SECURITY: Resolve real path if it exists, otherwise validate the resolved path
    let resolvedPath: string;
    if (fs.existsSync(absolutePath)) {
      try {
        resolvedPath = fs.realpathSync(absolutePath);
      } catch (error) {
        return err(
          new AutobeatError(
            ErrorCode.INVALID_INPUT,
            `Cannot resolve path: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    } else {
      // Path doesn't exist yet - validate parent directory
      const parentDir = path.dirname(absolutePath);
      if (fs.existsSync(parentDir)) {
        try {
          const resolvedParent = fs.realpathSync(parentDir);
          const basename = path.basename(absolutePath);
          resolvedPath = path.join(resolvedParent, basename);
        } catch (error) {
          return err(
            new AutobeatError(
              ErrorCode.INVALID_INPUT,
              `Cannot resolve parent directory: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      } else {
        // Use logical path resolution for non-existent paths
        resolvedPath = absolutePath;
      }
    }

    // SECURITY: Check if the resolved real path is within the base directory
    // This catches symlink attacks where a symlink points outside the base
    if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `Path traversal detected: ${inputPath} resolves to ${resolvedPath} which is outside of ${resolvedBase}`,
        ),
      );
    }

    return ok(resolvedPath);
  } catch (error) {
    return err(
      new AutobeatError(
        ErrorCode.INVALID_INPUT,
        `Invalid path: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * Validate buffer size is within reasonable limits
 * Prevents memory exhaustion attacks by enforcing size limits
 * @param size Buffer size in bytes to validate
 * @returns Validated size or error if outside limits (1KB - 1GB)
 */
export function validateBufferSize(size: number): Result<number> {
  const MIN_BUFFER = 1024; // 1KB
  const MAX_BUFFER = 1073741824; // 1GB

  if (isNaN(size) || size < MIN_BUFFER) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Buffer size must be at least ${MIN_BUFFER} bytes`));
  }

  if (size > MAX_BUFFER) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Buffer size cannot exceed ${MAX_BUFFER} bytes (1GB)`));
  }

  return ok(size);
}

/**
 * Validate timeout is within reasonable limits
 * Prevents resource exhaustion by enforcing timeout limits
 * @param timeout Timeout in milliseconds to validate
 * @returns Validated timeout or error if outside limits (1s - 24h)
 */
export function validateTimeout(timeout: number): Result<number> {
  const MIN_TIMEOUT = 1000; // 1 second
  const MAX_TIMEOUT = 86400000; // 24 hours

  if (isNaN(timeout) || timeout < MIN_TIMEOUT) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Timeout must be at least ${MIN_TIMEOUT}ms`));
  }

  if (timeout > MAX_TIMEOUT) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Timeout cannot exceed ${MAX_TIMEOUT}ms (24 hours)`));
  }

  return ok(timeout);
}

/**
 * Cron expression utilities for task scheduling
 * ARCHITECTURE: Pure functions returning Result types, no side effects
 * Pattern: Parse-don't-validate - validates cron expressions at boundary
 */

import type { CronExpression } from 'cron-parser';
import cronParser from 'cron-parser';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { err, ok, Result } from '../core/result.js';

const { parseExpression } = cronParser;

/**
 * Validate a cron expression
 *
 * @param expression Standard 5-field cron expression (minute hour day month weekday)
 * @returns Result<void> - ok if valid, err with details if invalid
 *
 * @example
 * validateCronExpression('0 9 * * 1-5'); // Ok - 9am weekdays
 * validateCronExpression('invalid'); // Err - Invalid cron expression
 */
export function validateCronExpression(expression: string): Result<void, AutobeatError> {
  try {
    parseExpression(expression);
    return ok(undefined);
  } catch (error) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid cron expression: ${expression}`, {
        expression,
        parseError: String(error),
      }),
    );
  }
}

/**
 * Calculate next run time from cron expression
 *
 * @param expression Cron expression (5-field standard)
 * @param timezone IANA timezone (e.g., 'America/New_York', 'UTC')
 * @param afterTime Calculate next run after this time (default: now)
 * @returns Result<number> - epoch milliseconds of next run
 *
 * @example
 * getNextRunTime('0 9 * * *', 'UTC'); // Next 9am UTC
 * getNextRunTime('0,15,30,45 * * * *', 'America/New_York', new Date('2025-01-01')); // Every 15 minutes
 */
export function getNextRunTime(expression: string, timezone: string, afterTime?: Date): Result<number, AutobeatError> {
  try {
    const interval = parseExpression(expression, {
      currentDate: afterTime ?? new Date(),
      tz: timezone,
    });
    return ok(interval.next().getTime());
  } catch (error) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, `Failed to calculate next run time`, {
        expression,
        timezone,
        error: String(error),
      }),
    );
  }
}

/**
 * Calculate next N run times from cron expression
 * Useful for preview/debugging schedule patterns
 *
 * @param expression Cron expression (5-field standard)
 * @param timezone IANA timezone
 * @param count Number of future runs to calculate (default: 5)
 * @param afterTime Start time (default: now)
 * @returns Result<number[]> - array of epoch milliseconds
 */
export function getNextRunTimes(
  expression: string,
  timezone: string,
  count: number = 5,
  afterTime?: Date,
): Result<readonly number[], AutobeatError> {
  try {
    const interval = parseExpression(expression, {
      currentDate: afterTime ?? new Date(),
      tz: timezone,
    });

    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      times.push(interval.next().getTime());
    }

    return ok(times);
  } catch (error) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, `Failed to calculate next run times`, {
        expression,
        timezone,
        count,
        error: String(error),
      }),
    );
  }
}

/**
 * Validate IANA timezone string
 *
 * @param timezone IANA timezone identifier (e.g., 'America/New_York', 'Europe/London', 'UTC')
 * @returns true if valid IANA timezone, false otherwise
 *
 * @example
 * isValidTimezone('UTC'); // true
 * isValidTimezone('America/New_York'); // true
 * isValidTimezone('Invalid/Zone'); // false
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    // Intl.DateTimeFormat throws RangeError for invalid timezones
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate timezone and return Result
 * Use this when you need detailed error information
 *
 * @param timezone IANA timezone identifier
 * @returns Result<void> - ok if valid, err with details if invalid
 */
export function validateTimezone(timezone: string): Result<void, AutobeatError> {
  if (isValidTimezone(timezone)) {
    return ok(undefined);
  }
  return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid timezone: ${timezone}`, { timezone }));
}

/**
 * Parse cron expression and return the parsed interval for advanced use
 * ARCHITECTURE: Exposes cron-parser interface for advanced operations
 *
 * @param expression Cron expression
 * @param timezone IANA timezone
 * @param currentDate Reference date (default: now)
 * @returns Result<CronExpression> - parsed cron interval
 */
export function parseCronExpression(
  expression: string,
  timezone: string,
  currentDate?: Date,
): Result<CronExpression, AutobeatError> {
  try {
    const interval = parseExpression(expression, {
      currentDate: currentDate ?? new Date(),
      tz: timezone,
    });
    return ok(interval);
  } catch (error) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, `Failed to parse cron expression`, {
        expression,
        timezone,
        error: String(error),
      }),
    );
  }
}

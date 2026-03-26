/**
 * Structured JSON logger implementation
 * Following our principle: always use structured logging
 */

import { Logger } from '../core/interfaces.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export class StructuredLogger implements Logger {
  private readonly context: Record<string, unknown>;
  private readonly level: LogLevel;

  constructor(
    context: Record<string, unknown> = {},
    level: LogLevel = LogLevel.INFO,
    private readonly output: (entry: LogEntry) => void = (entry) => console.error(JSON.stringify(entry)), // Use stderr for MCP compatibility
  ) {
    this.context = { ...context };
    this.level = level;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log('debug', message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      this.log('info', message, context);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      this.log('warn', message, context);
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: 'error',
        message,
        context: { ...this.context, ...context },
      };

      if (error) {
        entry.error = {
          name: error.name,
          message: error.message,
          stack: error.stack,
        };
      }

      this.output(entry);
    }
  }

  child(context: Record<string, unknown>): Logger {
    return new StructuredLogger({ ...this.context, ...context }, this.level, this.output);
  }

  private log(level: string, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context, ...context },
    };

    this.output(entry);
  }
}

/**
 * Console logger for development
 */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;

  constructor(
    private readonly prefix = '[Autobeat]',
    private readonly useColors = true,
    level: LogLevel = LogLevel.INFO,
  ) {
    this.level = level;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.DEBUG) return;
    const color = this.useColors ? '\x1b[36m' : ''; // Cyan
    const reset = this.useColors ? '\x1b[0m' : '';
    // Use stderr for all logs to avoid interfering with MCP communication on stdout
    console.error(`${color}${this.prefix} DEBUG:${reset} ${message}`, context || '');
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.INFO) return;
    const color = this.useColors ? '\x1b[32m' : ''; // Green
    const reset = this.useColors ? '\x1b[0m' : '';
    // Use stderr for all logs to avoid interfering with MCP communication on stdout
    console.error(`${color}${this.prefix} INFO:${reset} ${message}`, context || '');
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.WARN) return;
    const color = this.useColors ? '\x1b[33m' : ''; // Yellow
    const reset = this.useColors ? '\x1b[0m' : '';
    // Use stderr for all logs to avoid interfering with MCP communication on stdout
    console.error(`${color}${this.prefix} WARN:${reset} ${message}`, context || '');
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.ERROR) return;
    const color = this.useColors ? '\x1b[31m' : ''; // Red
    const reset = this.useColors ? '\x1b[0m' : '';
    console.error(`${color}${this.prefix} ERROR:${reset} ${message}`, context || '');
    if (error) {
      console.error(error);
    }
  }

  child(context: Record<string, unknown>): Logger {
    const childPrefix = context.module ? `${this.prefix}[${context.module}]` : this.prefix;
    return new ConsoleLogger(childPrefix, this.useColors, this.level);
  }
}

/**
 * Test logger that captures logs
 */
export class TestLogger implements Logger {
  public readonly logs: Array<{
    level: string;
    message: string;
    context?: Record<string, unknown>;
    error?: Error;
  }> = [];

  debug(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, context });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, context });
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message, context, error });
  }

  child(context: Record<string, unknown>): Logger {
    return this; // For testing, just return same instance
  }

  clear(): void {
    this.logs.length = 0;
  }

  hasLog(level: string, message: string): boolean {
    return this.logs.some((log) => log.level === level && log.message === message);
  }
}

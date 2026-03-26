import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { AutobeatError } from '../../src/core/errors';
import { ProcessSpawner } from '../../src/core/interfaces';
import { err, ok, Result } from '../../src/core/result';

/**
 * Mock process spawner for testing
 * Simulates Claude command execution without requiring the actual CLI
 */
export class MockProcessSpawner implements ProcessSpawner {
  private processes = new Map<string, MockChildProcess>();
  private shouldFail = false;
  private failureMessage = 'Mock failure';
  private executionDelay = 100;

  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }> {
    if (this.shouldFail) {
      return err(new AutobeatError(this.failureMessage, 'SPAWN_FAILED'));
    }

    // Simulate Claude command execution
    const mockProcess = new MockChildProcess(prompt, this.executionDelay);
    this.processes.set(mockProcess.pid.toString(), mockProcess);

    // Store taskId association if provided
    if (taskId) {
      this.processes.set(taskId, mockProcess);
    }

    // Start execution after a small delay
    setTimeout(() => mockProcess.execute(), 10);

    return ok({
      process: mockProcess as unknown as ChildProcess,
      pid: mockProcess.pid,
    });
  }

  // Test helper methods
  setFailure(shouldFail: boolean, message?: string): void {
    this.shouldFail = shouldFail;
    if (message) {
      this.failureMessage = message;
    }
  }

  setExecutionDelay(delay: number): void {
    this.executionDelay = delay;
  }

  getProcess(pid: string): MockChildProcess | undefined {
    return this.processes.get(pid);
  }

  cleanup(): void {
    for (const process of this.processes.values()) {
      process.kill();
    }
    this.processes.clear();
  }

  // Additional test helper methods for integration tests
  simulateCompletion(taskId: string, output: string): void {
    // Try to find process by taskId first
    const processByTaskId = this.processes.get(taskId);
    if (processByTaskId && !processByTaskId.killed) {
      processByTaskId.stdout.emit('data', Buffer.from(output + '\n'));
      processByTaskId.exitCode = 0;
      processByTaskId.emit('exit', 0, null);
      return;
    }

    // Fallback: complete first active process
    for (const [pid, process] of this.processes) {
      if (!process.killed) {
        process.stdout.emit('data', Buffer.from(output + '\n'));
        process.exitCode = 0;
        process.emit('exit', 0, null);
        break;
      }
    }
  }

  simulateError(taskId: string, error: Error): void {
    // Try to find process by taskId first
    const processByTaskId = this.processes.get(taskId);
    if (processByTaskId && !processByTaskId.killed) {
      processByTaskId.stderr.emit('data', Buffer.from(error.message + '\n'));
      processByTaskId.exitCode = 1;
      processByTaskId.emit('exit', 1, null);
      return;
    }

    // Fallback: error first active process
    for (const [pid, process] of this.processes) {
      if (!process.killed) {
        process.stderr.emit('data', Buffer.from(error.message + '\n'));
        process.exitCode = 1;
        process.emit('exit', 1, null);
        break;
      }
    }
  }

  getActiveTasks(): string[] {
    const active: string[] = [];
    for (const [pid, process] of this.processes) {
      if (!process.killed && process.exitCode === null) {
        active.push(pid); // Use pid as task identifier
      }
    }
    return active;
  }

  simulateHighCPU(percent: number): void {
    // This would be handled by mock resource monitor
    // Just a placeholder for integration tests
  }
}

/**
 * Mock ChildProcess for simulating Claude execution
 */
class MockChildProcess extends EventEmitter {
  public readonly pid: number;
  public readonly stdout: EventEmitter;
  public readonly stderr: EventEmitter;
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: string | null = null;

  private prompt: string;
  private executionDelay: number;
  private timeout?: NodeJS.Timeout;

  constructor(prompt: string, executionDelay = 100) {
    super();
    this.pid = Math.floor(Math.random() * 100000);
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.prompt = prompt;
    this.executionDelay = executionDelay;

    // Make stdout and stderr look like streams
    (this.stdout as unknown as Record<string, unknown>).pipe = () => this.stdout;
    (this.stderr as unknown as Record<string, unknown>).pipe = () => this.stderr;
  }

  execute(): void {
    if (this.killed) {
      return;
    }

    // Simulate different behaviors based on the prompt
    if (this.prompt.includes('exit 1')) {
      // Simulate command failure
      this.timeout = setTimeout(() => {
        this.stderr.emit('data', Buffer.from('Command failed\n'));
        this.exitCode = 1;
        this.emit('exit', 1, null);
      }, this.executionDelay);
    } else if (this.prompt.includes('sleep')) {
      // Extract sleep duration
      const match = this.prompt.match(/sleep (\d+)/);
      const sleepDuration = match ? parseInt(match[1]) * 1000 : 1000;

      // Simulate long-running command
      this.stdout.emit('data', Buffer.from('Starting long task\n'));

      this.timeout = setTimeout(
        () => {
          if (!this.killed) {
            this.stdout.emit('data', Buffer.from('Task completed\n'));
            this.exitCode = 0;
            this.emit('exit', 0, null);
          }
        },
        Math.min(sleepDuration, 5000),
      ); // Cap at 5 seconds for tests
    } else if (this.prompt.includes('echo')) {
      // Extract echo content
      const match = this.prompt.match(/echo ["']?(.+?)["']?(?:\s|$)/);
      const content = match ? match[1] : 'test output';

      // Simulate echo command
      this.timeout = setTimeout(() => {
        this.stdout.emit('data', Buffer.from(`${content}\n`));
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }, this.executionDelay);
    } else if (this.prompt.includes('pwd')) {
      // Simulate pwd command
      this.timeout = setTimeout(() => {
        this.stdout.emit('data', Buffer.from('/workspace/autobeat\n'));
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }, this.executionDelay);
    } else if (this.prompt.includes('ls')) {
      // Simulate ls command
      this.timeout = setTimeout(() => {
        this.stdout.emit('data', Buffer.from('file1.txt\nfile2.txt\ndir1/\n'));
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }, this.executionDelay);
    } else if (this.prompt.includes('for')) {
      // Simulate loop output
      this.timeout = setTimeout(() => {
        for (let i = 1; i <= 5; i++) {
          this.stdout.emit('data', Buffer.from(`Line ${i}\n`));
        }
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }, this.executionDelay);
    } else if (this.prompt.includes('kill')) {
      // Simulate process crash
      this.timeout = setTimeout(() => {
        this.stdout.emit('data', Buffer.from('Before crash\n'));
        this.signalCode = 'SIGKILL';
        this.emit('exit', null, 'SIGKILL');
      }, this.executionDelay);
    } else {
      // Default simulation
      this.timeout = setTimeout(() => {
        this.stdout.emit('data', Buffer.from(`Executed: ${this.prompt}\n`));
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }, this.executionDelay);
    }
  }

  kill(signal?: string): boolean {
    if (this.killed) {
      return false;
    }

    this.killed = true;

    if (this.timeout) {
      clearTimeout(this.timeout);
    }

    // Emit exit event with signal
    this.signalCode = signal || 'SIGTERM';
    setImmediate(() => {
      this.emit('exit', null, this.signalCode);
    });

    return true;
  }

  // Implement other ChildProcess methods as no-ops or minimal implementations
  ref(): void {}
  unref(): void {}
  disconnect(): void {}
  send(): boolean {
    return false;
  }
}

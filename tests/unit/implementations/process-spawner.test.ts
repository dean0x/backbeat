import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProcessSpawner } from '../../../src/implementations/process-spawner';
import { TEST_COUNTS, TIMEOUTS } from '../../constants';
import { createTestConfiguration } from '../../fixtures/factories';
import { createMockChildProcess } from '../../fixtures/test-helpers';

// Mock child_process module
let mockSpawnImpl: (...args: unknown[]) => ChildProcess | null = () => null;
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawnImpl(...args),
}));

describe('ClaudeProcessSpawner - Behavioral Tests', () => {
  let spawner: ClaudeProcessSpawner;
  let mockProcess: ChildProcess & EventEmitter;
  let spawnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawner = new ClaudeProcessSpawner(createTestConfiguration());

    // Create a properly typed mock child process
    mockProcess = createMockChildProcess({
      kill: function (this: ChildProcess, signal?: string) {
        // Simulate real process.kill behavior
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          setImmediate(() => {
            this.emit('exit', 0, signal);
          });
          return true;
        }
        return false;
      },
    }) as ChildProcess & EventEmitter;

    // Create a spy function that tracks calls
    spawnSpy = vi.fn((...args: unknown[]) => mockProcess);
    mockSpawnImpl = spawnSpy;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Process spawning behavior', () => {
    it('should successfully spawn a process and return process handle with PID', () => {
      const result = spawner.spawn('echo hello', '/tmp');

      // Test BEHAVIOR, not mock calls
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Verify we get a process handle
        expect(result.value.process).toBeDefined();
        expect(result.value.process.stdout).toBeDefined();
        expect(result.value.process.stderr).toBeDefined();
        expect(result.value.process.stdin).toBeDefined();
        expect(result.value.process.kill).toBeDefined();
        expect(typeof result.value.process.kill).toBe('function');

        // Verify we get a PID for process management
        expect(result.value.pid).toBe(12345);
        expect(typeof result.value.pid).toBe('number');
        expect(result.value.pid).toBeGreaterThan(0);

        // Verify process properties
        expect(result.value.process.pid).toBe(12345);
        expect(result.value.process.connected).toBe(false);
        expect(result.value.process.killed).toBe(false);
        expect(result.value.process.exitCode).toBeNull();
        expect(result.value.process.signalCode).toBeNull();
        expect(Array.isArray(result.value.process.spawnargs)).toBe(true);
        expect(typeof result.value.process.spawnfile).toBe('string');
      }
    });

    it('should handle spawn failures gracefully and return error', () => {
      spawnSpy.mockImplementation(() => {
        throw new Error('Command not found: claude');
      });

      const result = spawner.spawn('test', '/dir');

      // Test error handling BEHAVIOR
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toContain('Command not found');
        expect(typeof result.error.message).toBe('string');
        expect(result.error.name).toBe('AutobeatError');
        expect(result.error.stack).toBeDefined();
      }
      if (!result.ok) {
        expect(result.error.code).toBe('PROCESS_SPAWN_FAILED');
        expect(result.error.message).toContain('Command not found');
        // Ensure error has context for debugging
        expect(result.error.context).toBeDefined();
      }
    });

    it('should handle missing PID as a critical error', () => {
      mockProcess.pid = undefined;

      const result = spawner.spawn('test', '/dir');

      // Test that missing PID is treated as failure
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to get process PID');
        expect(result.error.code).toBe('PROCESS_SPAWN_FAILED');
      }
    });

    it('should emit stdout data from spawned process', () => {
      const result = spawner.spawn('echo test', '/tmp');

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { process } = result.value;

        // Test that we can receive output - use promise instead of done()
        return new Promise<void>((resolve) => {
          process.stdout?.on('data', (data) => {
            expect(data).toBeDefined();
            resolve();
          });

          // Simulate process output
          setImmediate(() => {
            (process.stdout as EventEmitter).emit('data', Buffer.from('test output'));
          });
        });
      }
    });

    it('should emit stderr data from spawned process', () => {
      const result = spawner.spawn('echo error', '/tmp');

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { process } = result.value;

        // Test that we can receive errors - use promise instead of done()
        return new Promise<void>((resolve) => {
          process.stderr?.on('data', (data) => {
            expect(data).toBeDefined();
            resolve();
          });

          // Simulate process error output
          setImmediate(() => {
            (process.stderr as EventEmitter).emit('data', Buffer.from('error output'));
          });
        });
      }
    });

    it('should wrap simple commands with execution instruction', () => {
      // Test BEHAVIOR: simple commands get wrapped for Claude
      const simpleCommands = ['ls', 'pwd', 'echo test', 'cat file.txt'];

      simpleCommands.forEach((cmd) => {
        spawnSpy.mockClear();
        const result = spawner.spawn(cmd, '/dir');

        expect(result.ok).toBe(true);
        // Verify the command was processed (wrapped)
        const lastArg = spawnSpy.mock.calls[0]?.[1]?.slice(-1)[0];
        expect(lastArg).toContain('Execute the following bash command:');
        expect(lastArg).toContain(cmd);
      });
    });

    it('should not wrap complex prompts that already have instructions', () => {
      const complexPrompts = [
        'Run the test suite and fix any errors',
        'Execute npm install',
        'Please perform a code review',
        'Use bash to list files',
        'Run this command: echo hello',
      ];

      complexPrompts.forEach((prompt) => {
        spawnSpy.mockClear();
        const result = spawner.spawn(prompt, '/dir');

        expect(result.ok).toBe(true);
        // Verify complex prompts are passed as-is
        const lastArg = spawnSpy.mock.calls[0]?.[1]?.slice(-1)[0];
        expect(lastArg).toBe(prompt);
      });
    });
  });

  describe('Process killing behavior', () => {
    let processKillSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      // Mock process.kill with a spy
      processKillSpy = vi.fn((pid: number, signal?: string): boolean => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });
      process.kill = processKillSpy as typeof process.kill;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should gracefully terminate process with SIGTERM first', () => {
      const pid = 54321;
      const result = spawner.kill(pid);

      expect(result.ok).toBe(true);
      expect(processKillSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
      expect(processKillSpy).toHaveBeenCalledTimes(1);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
      expect(processKillSpy).not.toHaveBeenCalledWith(pid, 'SIGKILL');
      expect(typeof pid).toBe('number');
      expect(pid).toBeGreaterThan(0);
    });

    it('should escalate to SIGKILL after grace period', () => {
      const pid = 54321;
      const result = spawner.kill(pid);

      expect(result.ok).toBe(true);
      // Initially only SIGTERM
      expect(processKillSpy).toHaveBeenCalledTimes(1);
      expect(processKillSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
      expect(processKillSpy).toHaveBeenNthCalledWith(1, pid, 'SIGTERM');

      // After grace period, SIGKILL
      vi.advanceTimersByTime(TIMEOUTS.LONG);
      expect(processKillSpy).toHaveBeenCalledTimes(2);
      expect(processKillSpy).toHaveBeenCalledWith(pid, 'SIGKILL');
      expect(processKillSpy).toHaveBeenNthCalledWith(2, pid, 'SIGKILL');
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(0);
    });

    it('should handle kill failures and return appropriate error', () => {
      const invalidPid = 99999;
      const result = spawner.kill(invalidPid);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROCESS_KILL_FAILED');
        expect(result.error.message).toContain('99999');
        expect(result.error.message).toContain('No such process');
        expect(result.error.name).toBe('AutobeatError');
        expect(result.error.context).toBeDefined();
        expect(result.error.context?.pid).toBe(invalidPid);
        expect(typeof result.error.message).toBe('string');
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    });

    it('should clean up kill timeouts on dispose', () => {
      vi.useFakeTimers();

      // Start killing multiple processes
      spawner.kill(11111);
      spawner.kill(22222);
      spawner.kill(33333);

      // Should have 3 pending timeouts
      expect(vi.getTimerCount()).toBe(3);

      // Dispose should clean them all
      spawner.dispose();
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('Working directory behavior', () => {
    it('should spawn process in specified working directory', () => {
      const testDir = '/home/test/project';
      const result = spawner.spawn('ls', testDir);

      expect(result.ok).toBe(true);

      // Verify process would run in correct directory
      const spawnCall = spawnSpy.mock.calls[0];
      expect(spawnCall[2].cwd).toBe(testDir);
    });

    it('should handle relative and absolute paths correctly', () => {
      const paths = ['.', '..', '/absolute/path', './relative', '../parent'];

      paths.forEach((path) => {
        spawnSpy.mockClear();
        const result = spawner.spawn('pwd', path);

        expect(result.ok).toBe(true);
        const spawnCall = spawnSpy.mock.calls[0];
        expect(spawnCall[2].cwd).toBe(path);
      });
    });
  });

  describe('Environment variable behavior', () => {
    it('should preserve existing environment variables', () => {
      const originalEnv = { ...process.env };
      process.env.CUSTOM_VAR = 'test-value';
      process.env.PATH = '/usr/bin:/bin';

      const result = spawner.spawn('echo $CUSTOM_VAR', '/tmp');

      expect(result.ok).toBe(true);
      const spawnCall = spawnSpy.mock.calls[0];
      expect(spawnCall[2].env.CUSTOM_VAR).toBe('test-value');
      expect(spawnCall[2].env.PATH).toBe('/usr/bin:/bin');
      expect(spawnCall[2].env.AUTOBEAT_WORKER).toBe('true');

      process.env = originalEnv;
    });

    it('should add AUTOBEAT_TASK_ID when task ID provided', () => {
      const taskId = 'task-abc-123';
      const result = spawner.spawn('test', '/tmp', taskId);

      expect(result.ok).toBe(true);
      const spawnCall = spawnSpy.mock.calls[0];
      expect(spawnCall[2].env.AUTOBEAT_TASK_ID).toBe(taskId);
      expect(spawnCall[2].env.AUTOBEAT_WORKER).toBe('true');
    });
  });

  describe('Error handling patterns', () => {
    it('should wrap all spawn errors in Result type', () => {
      const errors = [
        new Error('ENOENT'),
        new Error('EACCES'),
        new Error('spawn claude ENOENT'),
        'string error',
        null,
        undefined,
      ];

      errors.forEach((error) => {
        spawnSpy.mockImplementation(() => {
          throw error;
        });

        const result = spawner.spawn('test', '/dir');

        // All errors should be wrapped consistently
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
          expect(result.error.code).toBe('PROCESS_SPAWN_FAILED');
          expect(result.error.message).toBeDefined();
        }
      });
    });

    it('should handle process crash after successful spawn', () => {
      const result = spawner.spawn('test', '/dir');

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { process } = result.value;

        // Use promise instead of done()
        return new Promise<void>((resolve) => {
          process.on('error', (err) => {
            expect(err.message).toBe('Process crashed');
            resolve();
          });

          // Simulate crash after spawn
          setImmediate(() => {
            process.emit('error', new Error('Process crashed'));
          });
        });
      }
    });
  });

  describe('Resource cleanup', () => {
    it('should not leak resources when spawning many processes', () => {
      const pids: number[] = [];

      // Spawn many processes
      for (let i = 0; i < 100; i++) {
        mockProcess.pid = TEST_COUNTS.STRESS_TEST * 10 + i;
        const result = spawner.spawn(`task ${i}`, '/tmp');

        expect(result.ok).toBe(true);
        if (result.ok) {
          pids.push(result.value.pid);
        }
      }

      // All should have unique PIDs
      const uniquePids = new Set(pids);
      expect(uniquePids.size).toBe(100);
    });

    it('should handle rapid spawn and kill cycles', () => {
      vi.useFakeTimers();

      for (let i = 0; i < 10; i++) {
        mockProcess.pid = 20000 + i;
        const result = spawner.spawn('quick task', '/tmp');

        if (result.ok) {
          const killResult = spawner.kill(result.value.pid);
          expect(killResult.ok).toBe(true);
        }
      }

      // Advance time to trigger all SIGKILL timeouts
      vi.advanceTimersByTime(TIMEOUTS.LONG);

      // Cleanup should handle all
      spawner.dispose();
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('Environment variable handling', () => {
    it('should strip all Claude Code nesting indicators from worker environment', () => {
      // Capture originals for restoration
      const saved: Record<string, string | undefined> = {};
      const varsToSet: Record<string, string> = {
        CLAUDECODE: 'true',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      };

      for (const key of Object.keys(varsToSet)) {
        saved[key] = process.env[key];
        process.env[key] = varsToSet[key];
      }

      try {
        const result = spawner.spawn('test task', '/tmp', 'task-123');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const spawnCall = spawnSpy.mock.calls[0];
          const env = (spawnCall[2] as { env: Record<string, string> }).env;

          // All nesting indicators must be stripped
          expect(env.CLAUDECODE).toBeUndefined();
          expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
          expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();

          // Autobeat vars must be present
          expect(env.AUTOBEAT_WORKER).toBe('true');
          expect(env.AUTOBEAT_TASK_ID).toBe('task-123');
        }
      } finally {
        for (const [key, original] of Object.entries(saved)) {
          if (original !== undefined) {
            process.env[key] = original;
          } else {
            delete process.env[key];
          }
        }
      }
    });

    it('should strip all CLAUDE_CODE_* prefixed env vars', () => {
      const saved = process.env.CLAUDE_CODE_FUTURE_FLAG;
      process.env.CLAUDE_CODE_FUTURE_FLAG = 'enabled';

      try {
        const result = spawner.spawn('test task', '/tmp');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const spawnCall = spawnSpy.mock.calls[0];
          const env = (spawnCall[2] as { env: Record<string, string> }).env;

          expect(env.CLAUDE_CODE_FUTURE_FLAG).toBeUndefined();
        }
      } finally {
        if (saved !== undefined) {
          process.env.CLAUDE_CODE_FUTURE_FLAG = saved;
        } else {
          delete process.env.CLAUDE_CODE_FUTURE_FLAG;
        }
      }
    });

    it('should preserve non-Claude-Code env vars', () => {
      const saved: Record<string, string | undefined> = {};
      const safeVars: Record<string, string> = {
        CLAUDE_API_KEY: 'sk-test-key',
        ANTHROPIC_API_KEY: 'sk-ant-key',
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
      };

      for (const key of Object.keys(safeVars)) {
        saved[key] = process.env[key];
        process.env[key] = safeVars[key];
      }

      try {
        const result = spawner.spawn('test task', '/tmp');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const spawnCall = spawnSpy.mock.calls[0];
          const env = (spawnCall[2] as { env: Record<string, string> }).env;

          // These must NOT be stripped
          expect(env.CLAUDE_API_KEY).toBe('sk-test-key');
          expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-key');
          expect(env.PATH).toBe('/usr/bin:/bin');
          expect(env.HOME).toBe('/home/test');
        }
      } finally {
        for (const [key, original] of Object.entries(saved)) {
          if (original !== undefined) {
            process.env[key] = original;
          } else {
            delete process.env[key];
          }
        }
      }
    });
  });
});

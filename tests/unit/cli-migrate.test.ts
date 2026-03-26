/**
 * Tests for: beat migrate — Migrate from backbeat to autobeat
 *
 * Validates filesystem migration (data dir, db, MCP configs, env var scanning).
 * All fs operations injected via MigrateDeps for isolation.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MigrateDeps, type MigrateResult, runMigrate } from '../../src/cli/commands/migrate';

describe('beat migrate', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = path.join(tmpdir(), `autobeat-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    homeDir = path.join(tempDir, 'home');
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createDeps(overrides: Partial<MigrateDeps> = {}): MigrateDeps {
    return {
      existsSync: (p: string) => existsSync(p),
      renameSync: (oldPath: string, newPath: string) => renameSync(oldPath, newPath),
      readFileSync: (p: string) => readFileSync(p, 'utf-8'),
      writeFileSync: (p: string, content: string) => writeFileSync(p, content, 'utf-8'),
      homedir: () => homeDir,
      platform: () => 'darwin',
      cwd: () => tempDir,
      ...overrides,
    };
  }

  describe('nothing to migrate', () => {
    it('returns nothingToDo when ~/.backbeat does not exist', () => {
      const result = runMigrate(createDeps());

      expect(result.nothingToDo).toBe(true);
      expect(result.dataDirMoved).toBe(false);
      expect(result.dbRenamed).toBe(false);
      expect(result.mcpConfigsUpdated).toEqual([]);
    });
  });

  describe('data directory migration', () => {
    it('moves ~/.backbeat to ~/.autobeat', () => {
      const oldDir = path.join(homeDir, '.backbeat');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(path.join(oldDir, 'config.json'), '{"timeout":5000}');

      const result = runMigrate(createDeps());

      expect(result.dataDirMoved).toBe(true);
      expect(existsSync(path.join(homeDir, '.autobeat', 'config.json'))).toBe(true);
      expect(existsSync(oldDir)).toBe(false);
    });

    it('aborts with conflict when both ~/.backbeat and ~/.autobeat exist', () => {
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });
      mkdirSync(path.join(homeDir, '.autobeat'), { recursive: true });

      expect(() => runMigrate(createDeps())).toThrow('Both ~/.backbeat and ~/.autobeat exist');
    });
  });

  describe('database rename', () => {
    it('renames backbeat.db to autobeat.db after dir move', () => {
      const oldDir = path.join(homeDir, '.backbeat');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(path.join(oldDir, 'backbeat.db'), 'sqlite-data');

      const result = runMigrate(createDeps());

      expect(result.dbRenamed).toBe(true);
      expect(existsSync(path.join(homeDir, '.autobeat', 'autobeat.db'))).toBe(true);
      expect(existsSync(path.join(homeDir, '.autobeat', 'backbeat.db'))).toBe(false);
    });

    it('skips db rename when no backbeat.db exists', () => {
      const oldDir = path.join(homeDir, '.backbeat');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(path.join(oldDir, 'config.json'), '{}');

      const result = runMigrate(createDeps());

      expect(result.dbRenamed).toBe(false);
      expect(result.dataDirMoved).toBe(true);
    });
  });

  describe('MCP config migration', () => {
    it('updates .mcp.json in cwd with backbeat server key', () => {
      // Create old data dir to trigger migration
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });

      const mcpPath = path.join(tempDir, '.mcp.json');
      writeFileSync(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            backbeat: {
              command: 'npx',
              args: ['-y', 'backbeat', 'mcp', 'start'],
            },
            other: { command: 'other-cmd' },
          },
        }),
      );

      const result = runMigrate(createDeps());

      expect(result.mcpConfigsUpdated).toContain(mcpPath);
      const updated = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      expect(updated.mcpServers.autobeat).toBeDefined();
      expect(updated.mcpServers.backbeat).toBeUndefined();
      expect(updated.mcpServers.autobeat.args).toEqual(['-y', 'autobeat', 'mcp', 'start']);
      expect(updated.mcpServers.other).toBeDefined(); // untouched
    });

    it('updates claude_desktop_config.json on macOS', () => {
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });

      const claudeDir = path.join(homeDir, 'Library', 'Application Support', 'Claude');
      mkdirSync(claudeDir, { recursive: true });
      const configPath = path.join(claudeDir, 'claude_desktop_config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            backbeat: {
              command: 'npx',
              args: ['-y', 'backbeat', 'mcp', 'start'],
            },
          },
        }),
      );

      const result = runMigrate(createDeps());

      expect(result.mcpConfigsUpdated).toContain(configPath);
      const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(updated.mcpServers.autobeat).toBeDefined();
      expect(updated.mcpServers.backbeat).toBeUndefined();
    });

    it('skips MCP config files that do not contain backbeat key', () => {
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });

      const mcpPath = path.join(tempDir, '.mcp.json');
      writeFileSync(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            other: { command: 'other-cmd' },
          },
        }),
      );

      const result = runMigrate(createDeps());

      expect(result.mcpConfigsUpdated).not.toContain(mcpPath);
    });

    it('skips MCP config files that do not exist', () => {
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });

      const result = runMigrate(createDeps());

      expect(result.mcpConfigsUpdated).toEqual([]);
    });
  });

  describe('environment variable scanning', () => {
    it('detects BACKBEAT_ env vars in shell profiles', () => {
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });

      writeFileSync(
        path.join(homeDir, '.zshrc'),
        'export BACKBEAT_DATA_DIR=/custom/path\nexport PATH="$HOME/bin:$PATH"\n',
      );
      writeFileSync(path.join(homeDir, '.bashrc'), '# nothing relevant\n');

      const result = runMigrate(createDeps());

      expect(result.envVarFiles).toContain(path.join(homeDir, '.zshrc'));
      expect(result.envVarFiles).not.toContain(path.join(homeDir, '.bashrc'));
    });

    it('returns empty envVarFiles when no profiles contain BACKBEAT_', () => {
      mkdirSync(path.join(homeDir, '.backbeat'), { recursive: true });

      const result = runMigrate(createDeps());

      expect(result.envVarFiles).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('returns nothingToDo when only ~/.autobeat exists (already migrated)', () => {
      mkdirSync(path.join(homeDir, '.autobeat'), { recursive: true });

      const result = runMigrate(createDeps());

      expect(result.nothingToDo).toBe(true);
    });
  });
});

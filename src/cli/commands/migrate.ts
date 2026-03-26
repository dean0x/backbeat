/**
 * CLI command: beat migrate — Migrate from backbeat to autobeat
 *
 * Pure filesystem operation — no database connection needed.
 * Migrates: data directory, database file, MCP configs, env var detection.
 *
 * ARCHITECTURE: Core logic in runMigrate (pure, injected deps), CLI entry in migrateCommand.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import * as ui from '../ui.js';

// ============================================================================
// Types
// ============================================================================

export interface MigrateDeps {
  readonly existsSync: (path: string) => boolean;
  readonly renameSync: (oldPath: string, newPath: string) => void;
  readonly readFileSync: (path: string) => string;
  readonly writeFileSync: (path: string, content: string) => void;
  readonly homedir: () => string;
  readonly platform: () => string;
  readonly cwd: () => string;
}

export interface MigrateResult {
  readonly dataDirMoved: boolean;
  readonly dbRenamed: boolean;
  readonly mcpConfigsUpdated: readonly string[];
  readonly envVarFiles: readonly string[];
  readonly nothingToDo: boolean;
}

// ============================================================================
// Core Logic
// ============================================================================

export function runMigrate(deps: MigrateDeps): MigrateResult {
  const home = deps.homedir();
  const oldDir = path.join(home, '.backbeat');
  const newDir = path.join(home, '.autobeat');

  const oldExists = deps.existsSync(oldDir);
  const newExists = deps.existsSync(newDir);

  // Conflict: both exist
  if (oldExists && newExists) {
    throw new Error('Both ~/.backbeat and ~/.autobeat exist. Remove one before migrating.');
  }

  // Nothing to do: no old dir (fresh install or already migrated)
  if (!oldExists) {
    return { dataDirMoved: false, dbRenamed: false, mcpConfigsUpdated: [], envVarFiles: [], nothingToDo: true };
  }

  // Step 1: Move data directory
  deps.renameSync(oldDir, newDir);

  // Step 2: Rename database file inside new dir
  const oldDbPath = path.join(newDir, 'backbeat.db');
  const newDbPath = path.join(newDir, 'autobeat.db');
  let dbRenamed = false;
  if (deps.existsSync(oldDbPath)) {
    deps.renameSync(oldDbPath, newDbPath);
    dbRenamed = true;

    // Also rename WAL and SHM files if they exist
    const walPath = oldDbPath + '-wal';
    const shmPath = oldDbPath + '-shm';
    if (deps.existsSync(walPath)) {
      deps.renameSync(walPath, newDbPath + '-wal');
    }
    if (deps.existsSync(shmPath)) {
      deps.renameSync(shmPath, newDbPath + '-shm');
    }
  }

  // Step 3: Update MCP config files
  const mcpConfigsUpdated: string[] = [];
  const mcpConfigPaths = getMcpConfigPaths(deps);

  for (const configPath of mcpConfigPaths) {
    if (!deps.existsSync(configPath)) continue;

    try {
      const content = deps.readFileSync(configPath);
      const config = JSON.parse(content);

      const servers = config.mcpServers;
      if (!servers || typeof servers !== 'object' || !('backbeat' in servers)) continue;

      // Rename server key
      servers.autobeat = servers.backbeat;
      delete servers.backbeat;

      // Update args array: replace 'backbeat' with 'autobeat'
      const entry = servers.autobeat;
      if (entry && Array.isArray(entry.args)) {
        entry.args = entry.args.map((arg: string) => (arg === 'backbeat' ? 'autobeat' : arg));
      }

      deps.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      mcpConfigsUpdated.push(configPath);
    } catch {
      // Skip malformed config files silently
    }
  }

  // Step 4: Scan shell profiles for BACKBEAT_ env vars
  const envVarFiles: string[] = [];
  const shellProfiles = ['.bashrc', '.zshrc', '.bash_profile', '.profile'].map((f) => path.join(home, f));

  for (const profilePath of shellProfiles) {
    if (!deps.existsSync(profilePath)) continue;

    try {
      const content = deps.readFileSync(profilePath);
      if (content.includes('BACKBEAT_')) {
        envVarFiles.push(profilePath);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { dataDirMoved: true, dbRenamed, mcpConfigsUpdated, envVarFiles, nothingToDo: false };
}

// ============================================================================
// MCP Config Path Resolution
// ============================================================================

function getMcpConfigPaths(deps: MigrateDeps): readonly string[] {
  const home = deps.homedir();
  const paths: string[] = [path.join(deps.cwd(), '.mcp.json'), path.join(home, '.mcp.json')];

  if (deps.platform() === 'darwin') {
    paths.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  } else if (deps.platform() === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      paths.push(path.join(appData, 'Claude', 'claude_desktop_config.json'));
    }
  }

  return paths;
}

// ============================================================================
// Production Dependencies
// ============================================================================

function createDefaultDeps(): MigrateDeps {
  return {
    existsSync,
    renameSync,
    readFileSync: (p: string) => readFileSync(p, 'utf-8'),
    writeFileSync: (p: string, content: string) => writeFileSync(p, content, 'utf-8'),
    homedir,
    platform: () => process.platform,
    cwd: () => process.cwd(),
  };
}

// ============================================================================
// CLI Entry
// ============================================================================

export async function migrateCommand(): Promise<void> {
  ui.intro('Autobeat Migration');

  const deps = createDefaultDeps();

  let result: MigrateResult;
  try {
    result = runMigrate(deps);
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (result.nothingToDo) {
    ui.info('Nothing to migrate. No ~/.backbeat directory found.');
    ui.outro('Already on autobeat!');
    return;
  }

  // Report results
  if (result.dataDirMoved) {
    ui.success('Moved ~/.backbeat → ~/.autobeat');
  }

  if (result.dbRenamed) {
    ui.success('Renamed backbeat.db → autobeat.db');
  }

  if (result.mcpConfigsUpdated.length > 0) {
    ui.success(`Updated ${result.mcpConfigsUpdated.length} MCP config file(s):`);
    for (const f of result.mcpConfigsUpdated) {
      ui.step(`  ${f}`);
    }
  }

  if (result.envVarFiles.length > 0) {
    ui.info('Shell profiles with BACKBEAT_ environment variables (update manually):');
    for (const f of result.envVarFiles) {
      ui.step(`  ${f}`);
    }
    ui.info('Replace BACKBEAT_ with AUTOBEAT_ in the files above.');
  }

  ui.outro('Migration complete!');
}

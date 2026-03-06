/**
 * Claude Code agent adapter implementation
 *
 * ARCHITECTURE: Claude-specific logic on top of BaseAgentAdapter.
 * Includes prompt transformation for short commands and nesting prevention.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'claude';

  private readonly baseArgs: readonly string[];

  constructor(config: Configuration, claudeCommand = 'claude') {
    super(config, claudeCommand);
    this.baseArgs = Object.freeze(['--print', '--dangerously-skip-permissions', '--output-format', 'json']);
  }

  protected buildArgs(prompt: string): readonly string[] {
    return [...this.baseArgs, '--', prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // Strip CLAUDE_CODE_* prefix vars (e.g., CLAUDE_CODE_ENTRYPOINT)
    return ['CLAUDE_CODE_'];
  }

  protected get envExactMatchesToStrip(): readonly string[] {
    // Exact match for CLAUDECODE — avoids over-stripping CLAUDECODE_SESSION etc.
    return ['CLAUDECODE'];
  }
}

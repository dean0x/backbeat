/**
 * Google Gemini CLI agent adapter implementation
 *
 * ARCHITECTURE: Gemini-specific CLI flags on top of BaseAgentAdapter.
 * Uses --prompt for non-interactive (headless) mode and --yolo for auto-accept.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class GeminiAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'gemini';

  constructor(config: Configuration, geminiCommand = 'gemini') {
    super(config, geminiCommand);
  }

  // jsonSchema parameter accepted but ignored — Gemini CLI does not support structured output
  protected buildArgs(prompt: string, model?: string, _jsonSchema?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    return ['--yolo', ...modelArgs, '--prompt', prompt];
  }

  protected get additionalEnv(): Record<string, string> {
    // --yolo enables Docker sandbox by default; disable it so Docker/Podman isn't required.
    // Users who want sandbox can set GEMINI_SANDBOX=true in their environment.
    return { GEMINI_SANDBOX: 'false' };
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Gemini CLI nesting indicators.
    // IMPORTANT: Must NOT strip GEMINI_API_KEY — required for authentication.
    return [];
  }

  /**
   * @design GEMINI_SYSTEM_MD replaces the entire built-in system prompt.
   * To simulate "append": read the cached base prompt, combine with user's system prompt,
   * write the combined content to systemPromptPath, then set GEMINI_SYSTEM_MD.
   *
   * Cache strategy: ~/.autobeat/system-prompts/gemini-base.md populated on first use
   * via GEMINI_WRITE_SYSTEM_MD env var. Staleness advisory after 30 days.
   *
   * Fallback: If the base cache cannot be read or populated, prependToPrompt=true
   * is returned so the base class prepends the system prompt to the user prompt.
   * This avoids losing the user's system prompt at the cost of reduced effectiveness.
   */
  protected getSystemPromptConfig(
    systemPrompt: string,
    systemPromptPath: string,
  ): { args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean } {
    const cacheDir = path.join(os.homedir(), '.autobeat', 'system-prompts');
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    const STALENESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    // Attempt to read base cache
    if (existsSync(baseCachePath)) {
      try {
        const stat = statSync(baseCachePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > STALENESS_MS) {
          console.error(
            JSON.stringify({
              level: 'warn',
              message:
                'gemini-adapter: gemini-base.md cache is older than 30 days — run `beat agents refresh-base-prompt gemini` to refresh',
              ageMs,
            }),
          );
        }

        const baseContent = readFileSync(baseCachePath, 'utf8');
        const combined = `${baseContent}\n\n${systemPrompt}`;

        // Write combined prompt file and inject via GEMINI_SYSTEM_MD
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(systemPromptPath, combined, 'utf8');

        return {
          args: [],
          env: { GEMINI_SYSTEM_MD: systemPromptPath },
          prependToPrompt: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            level: 'warn',
            message: 'gemini-adapter: failed to read gemini-base.md cache, falling back to prompt prepend',
            error: msg,
          }),
        );
        return { args: [], env: {}, prependToPrompt: true };
      }
    }

    // No cache — fallback to prompt prepend with warning
    console.error(
      JSON.stringify({
        level: 'warn',
        message:
          'gemini-adapter: no gemini-base.md cache found, falling back to prompt prepend. Run `beat agents refresh-base-prompt gemini` to enable GEMINI_SYSTEM_MD injection.',
      }),
    );
    return { args: [], env: {}, prependToPrompt: true };
  }
}

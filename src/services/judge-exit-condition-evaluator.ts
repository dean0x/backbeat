/**
 * Judge exit condition evaluator
 *
 * ARCHITECTURE: Two-phase eval+judge strategy.
 * Phase 1 — Eval agent: runs with evalPrompt to produce findings.
 * Phase 2 — Judge agent: reads findings and writes a decision file.
 *
 * DECISION: Judge writes decision to a per-evaluation unique file.
 * Why: file creation is the most reliable cross-agent mechanism — all coding agents
 * can write files. stdout parsing is fragile because agents may emit logs, progress
 * messages, or other non-decision output. The filename includes the judgeTaskId to
 * prevent TOCTOU: the work agent runs in the same directory and cannot guess it.
 *
 * DECISION: Belt-and-suspenders for Claude judge.
 * If judgeAgent is 'claude', also inject --json-schema so structured output is
 * attempted. If both fail (file missing + structured parse error), default to 'continue'
 * (safe fallback — never block unexpectedly).
 *
 * Pattern: Strategy pattern — implements ExitConditionEvaluator
 */

import * as fsDefault from 'node:fs/promises';
import * as path from 'node:path';
import type { Loop, LoopId, TaskId } from '../core/domain.js';
import { createTask, TaskRequest } from '../core/domain.js';
import { EventBus } from '../core/events/event-bus.js';
import type {
  EvalResult,
  ExitConditionEvaluator,
  Logger,
  LoopRepository,
  OutputRepository,
} from '../core/interfaces.js';
import { buildEvalPromptBase, MAX_EVAL_FEEDBACK_LENGTH } from './eval-prompt-builder.js';
import { type TaskCompletionStatus, waitForEvalTaskCompletion } from './eval-task-waiter.js';

/**
 * Minimal fs interface needed by the judge evaluator.
 * Injectable for testability — avoids vi.mock('node:fs/promises') ESM contamination issues.
 *
 * DECISION: Inject fs as a dependency rather than import directly.
 * Why: vi.mock('node:fs/promises') at file scope leaks through vitest's shared module registry
 * in --no-file-parallelism runs (handler-setup.test.ts loads real fs after mock is set, which
 * clobbers the mock for subsequent tests). DI is the clean solution.
 */
export interface FsAdapter {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  unlink(path: string): Promise<void>;
}

/**
 * Unique decision file path for a judge task, scoped to its task ID.
 *
 * DECISION: Per-task filename (.autobeat-judge-{taskId}) instead of a fixed name.
 * Why: The work agent runs in the same working directory and could inadvertently
 * write a file named .autobeat-judge before the judge phase completes (TOCTOU).
 * Using the judgeTaskId makes the filename unguessable by the work agent, which
 * only knows its own task ID. The judge prompt includes the exact filename.
 */
function judgeDecisionFilePath(workingDirectory: string, judgeTaskId: string): string {
  return path.join(workingDirectory, `.autobeat-judge-${judgeTaskId}`);
}

/**
 * JSON schema for Claude judge structured output.
 * Belt-and-suspenders: file-based decision is primary, this is secondary.
 */
const JUDGE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    continue: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['continue', 'reasoning'],
});

export class JudgeExitConditionEvaluator implements ExitConditionEvaluator {
  private readonly fs: FsAdapter;

  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepo: OutputRepository,
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
    fs?: FsAdapter,
  ) {
    // Default to the real node:fs/promises; tests can inject a mock
    this.fs = fs ?? (fsDefault as FsAdapter);
  }

  /**
   * Evaluate iteration quality using two-phase eval+judge strategy.
   *
   * Phase 1: Eval agent runs evalPrompt → produces findings text.
   * Phase 2: Judge agent reads findings → writes .autobeat-judge with decision.
   * Decision extraction: structured output (Claude only), then file-based, then default continue.
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    // Phase 1: Gather findings via eval agent
    const findings = await this.runEvalAgent(loop, taskId);

    // Phase 2: Run judge agent with findings
    const judgeDecision = await this.runJudgeAgent(loop, findings ?? '');

    return {
      passed: false,
      decision: judgeDecision.continue ? 'continue' : 'stop',
      feedback: findings ?? undefined,
      evalResponse: JSON.stringify({
        judgeDecision: { continue: judgeDecision.continue, reasoning: judgeDecision.reasoning },
        evalFindings: findings,
      }),
    };
  }

  /**
   * Run the eval agent to generate findings.
   * ARCHITECTURE: Same pattern as AgentExitConditionEvaluator — TaskDelegated event,
   * waitForTaskCompletion, then read output. No jsonSchema — we want raw narrative findings.
   */
  private async runEvalAgent(loop: Loop, taskId: TaskId): Promise<string | null> {
    const prompt = await this.buildEvalPrompt(loop, taskId);

    const evalTaskRequest: TaskRequest = {
      prompt: `[EVAL] ${prompt}`,
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: loop.taskTemplate.agent,
    };
    const evalTask = createTask(evalTaskRequest);
    const evalTaskId = evalTask.id;

    this.logger.info('Starting judge eval task (phase 1)', {
      loopId: loop.id,
      evalTaskId,
      workTaskId: taskId,
    });

    const completionPromise = this.waitForTaskCompletion(evalTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: evalTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for judge eval task', emitResult.error, {
        loopId: loop.id,
        evalTaskId,
      });
      return null;
    }

    const completionStatus = await completionPromise;
    if (completionStatus.type !== 'completed') {
      this.logger.warn('Judge eval task (phase 1) did not complete successfully', {
        loopId: loop.id,
        evalTaskId,
        completionStatus: completionStatus.type,
      });
      return null;
    }

    const outputResult = await this.outputRepo.get(evalTaskId);
    if (!outputResult.ok || !outputResult.value) {
      this.logger.warn('Failed to read judge eval task output', {
        loopId: loop.id,
        evalTaskId,
      });
      return null;
    }

    const output = outputResult.value;
    const allLines = [...output.stdout, ...output.stderr].filter((l) => l.trim().length > 0);
    if (allLines.length === 0) return null;

    const joined = allLines.join('\n');
    return joined.length > MAX_EVAL_FEEDBACK_LENGTH ? joined.slice(0, MAX_EVAL_FEEDBACK_LENGTH) : joined;
  }

  /**
   * Run the judge agent to produce a decision.
   * Uses belt-and-suspenders: --json-schema for Claude, file-based for all agents.
   * Safe fallback: if both mechanisms fail, defaults to continue=true.
   */
  private async runJudgeAgent(loop: Loop, findings: string): Promise<{ continue: boolean; reasoning: string }> {
    const judgeAgent = loop.judgeAgent ?? loop.taskTemplate.agent;

    // Use jsonSchema only for Claude — other agents don't support structured output
    const jsonSchema = judgeAgent === 'claude' ? JUDGE_SCHEMA : undefined;

    // Create task first to get the unique judgeTaskId, then build prompt with the
    // unique decision filename derived from that ID (TOCTOU fix).
    const judgeTaskSkeleton = createTask({
      prompt: '[JUDGE] (building...)',
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: judgeAgent,
      jsonSchema,
    });
    const judgeTaskId = judgeTaskSkeleton.id;

    // Unique filename scoped to this judge task — avoids TOCTOU with the work agent
    const decisionFilePath = judgeDecisionFilePath(loop.workingDirectory, judgeTaskId);

    const judgePromptText = this.buildJudgePrompt(loop, findings, decisionFilePath);
    // Splice the real prompt in (task is frozen; spread creates a new plain object for the event payload)
    const judgeTask = { ...judgeTaskSkeleton, prompt: `[JUDGE] ${judgePromptText}` };

    this.logger.info('Starting judge decision task (phase 2)', {
      loopId: loop.id,
      judgeTaskId,
      judgeAgent,
    });

    await this.cleanupDecisionFile(decisionFilePath);

    const completionPromise = this.waitForTaskCompletion(judgeTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: judgeTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for judge decision task', emitResult.error, {
        loopId: loop.id,
        judgeTaskId,
      });
      // Safe fallback — never block on emission failure
      return { continue: true, reasoning: 'Judge task emission failed — defaulting to continue' };
    }

    const completionStatus = await completionPromise;
    if (completionStatus.type !== 'completed') {
      this.logger.warn('Judge decision task (phase 2) did not complete successfully', {
        loopId: loop.id,
        judgeTaskId,
        completionStatus: completionStatus.type,
      });
      return { continue: true, reasoning: `Judge task ${completionStatus.type} — defaulting to continue` };
    }

    // Secondary path for Claude: structured output (--json-schema, belt-and-suspenders).
    // For non-Claude agents tryParseStructuredOutput always returns null; file is the only path.
    const outputResult = await this.outputRepo.get(judgeTaskId);
    if (outputResult.ok && outputResult.value) {
      const structured = this.tryParseStructuredOutput(outputResult.value.stdout);
      if (structured) {
        await this.cleanupDecisionFile(decisionFilePath);
        return structured;
      }
    }

    // Primary mechanism for all agents: .autobeat-judge file written by the judge agent.
    const fileDecision = await this.readDecisionFile(decisionFilePath);
    if (fileDecision) {
      await this.cleanupDecisionFile(decisionFilePath);
      return fileDecision;
    }

    // Safe fallback: default to continue
    this.logger.warn('Judge decision not found in structured output or file — defaulting to continue', {
      loopId: loop.id,
      judgeTaskId,
    });
    return { continue: true, reasoning: 'Judge decision not found — defaulting to continue' };
  }

  /**
   * Build the eval prompt for phase 1 (findings gathering).
   */
  private async buildEvalPrompt(loop: Loop, taskId: TaskId): Promise<string> {
    const base = await buildEvalPromptBase(loop, taskId, this.loopRepo);
    const criteria = loop.evalPrompt ?? 'Review the code changes and provide detailed observations and findings.';

    return `You are reviewing the result of an automated code improvement iteration.
Provide detailed findings — a judge agent will read your output and make the final decision.

${base.contextHeader}

${base.toolInstructions}

${criteria}

Provide your detailed findings. There is no special format required — write naturally.`;
  }

  /**
   * Build the judge prompt for phase 2 (decision making).
   *
   * DECISION: File-based decision mechanism with per-task unique filename.
   * Why: All coding agents can write files — stdout capture is unreliable across agents.
   * The unique decisionFilePath (scoped to judgeTaskId) prevents TOCTOU races with the
   * work agent, which only knows its own task ID and cannot guess the judge filename.
   */
  private buildJudgePrompt(loop: Loop, findings: string, decisionFilePath: string): string {
    const judgeInstructions = loop.judgePrompt ?? 'Based on the findings, should the work continue iterating?';
    const decisionFileName = path.basename(decisionFilePath);

    return `You are evaluating whether a coding task should continue iterating.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}

=== Evaluation Findings ===
${findings || '(No findings provided)'}
===

${judgeInstructions}

IMPORTANT: Write your decision to the file \`${decisionFileName}\` in the working directory (${decisionFilePath}).
The file must contain valid JSON with exactly this structure:
{"continue": true, "reasoning": "..."} to continue iterating
{"continue": false, "reasoning": "..."} to stop

Example — continue: {"continue": true, "reasoning": "Progress is being made but tests still fail."}
Example — stop: {"continue": false, "reasoning": "All acceptance criteria are met."}

Do NOT include any other content in the file. The file will be read programmatically.`;
  }

  /**
   * Try to parse structured output from Claude's --json-schema response.
   * Belt-and-suspenders: file-based decision is primary, this is secondary.
   */
  private tryParseStructuredOutput(stdout: readonly string[]): { continue: boolean; reasoning: string } | null {
    if (stdout.length === 0) return null;

    const combined = stdout.join('');
    if (combined.length === 0) return null;

    const marker = '{"type":"result"';
    const markerIndex = combined.lastIndexOf(marker);
    if (markerIndex === -1) return null;

    const suffix = combined.slice(markerIndex);
    let parsed: unknown;
    try {
      parsed = JSON.parse(suffix);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'result') return null;

    const structuredOutput = obj.structured_output;
    if (!structuredOutput || typeof structuredOutput !== 'object') return null;
    const so = structuredOutput as Record<string, unknown>;

    if (typeof so.continue !== 'boolean') return null;
    const reasoning = typeof so.reasoning === 'string' ? so.reasoning : 'No reasoning provided';

    return { continue: so.continue, reasoning };
  }

  /**
   * Read and parse the decision file.
   * Returns null if file doesn't exist or contains invalid JSON.
   */
  private async readDecisionFile(filePath: string): Promise<{ continue: boolean; reasoning: string } | null> {
    try {
      const content = await this.fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as unknown;

      if (!parsed || typeof parsed !== 'object') {
        this.logger.warn('Judge decision file contains invalid JSON structure', { filePath });
        return null;
      }

      const obj = parsed as Record<string, unknown>;
      if (typeof obj.continue !== 'boolean') {
        this.logger.warn('Judge decision file missing "continue" boolean field', { filePath });
        return null;
      }

      const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : 'No reasoning provided';
      return { continue: obj.continue, reasoning };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — not an error, just wasn't written
        return null;
      }
      this.logger.warn('Failed to read judge decision file', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Remove the decision file to prevent stale decisions across iterations.
   * Errors are swallowed — cleanup failure is not fatal.
   */
  private async cleanupDecisionFile(filePath: string): Promise<void> {
    try {
      await this.fs.unlink(filePath);
    } catch {
      // ENOENT is expected when file doesn't exist — ignore all cleanup errors
    }
  }

  private waitForTaskCompletion(
    evalTaskId: TaskId,
    evalTimeout: number,
    loopId: LoopId,
  ): Promise<TaskCompletionStatus> {
    return waitForEvalTaskCompletion(evalTaskId, evalTimeout, loopId, {
      eventBus: this.eventBus,
      logger: this.logger,
    });
  }
}

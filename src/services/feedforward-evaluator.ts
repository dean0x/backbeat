/**
 * Feedforward exit condition evaluator
 *
 * ARCHITECTURE: Feedforward evaluator — findings only, no decision.
 * Why: default evalType that works with any agent. Loop continues until maxIterations.
 * consecutiveFailures is bypassed via decision: 'continue' so the loop counter never
 * increments for a quality-gate failure — this evaluator is purely informational.
 *
 * Pattern: Strategy pattern — implements ExitConditionEvaluator
 * Rationale: Enables prompt-level feedback gathering without gating iteration continuation.
 *             Useful when the exit strategy is time/iteration-based, not quality-based.
 */

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

export class FeedforwardEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepo: OutputRepository,
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Evaluate iteration quality using findings-only mode.
   *
   * DECISION: Always returns decision: 'continue'.
   * Why: feedforward is informational — it gathers findings without making a stop/go
   * decision. The loop handler checks decision BEFORE passed, so this bypasses
   * consecutiveFailures increment. Loop control is purely maxIterations-based.
   *
   * If evalPrompt is configured: spawns an eval agent to generate findings (feedback).
   * If no evalPrompt: returns immediately with no feedback — pure pass-through.
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    if (!loop.evalPrompt) {
      // No eval prompt configured — pure feedforward, no findings
      return { passed: false, decision: 'continue', feedback: undefined };
    }

    // Run eval agent for findings only (no decision extraction needed)
    const findings = await this.runEvalAgent(loop, taskId);
    return { passed: false, decision: 'continue', feedback: findings ?? undefined };
  }

  /**
   * Spawn an eval agent to generate findings.
   * ARCHITECTURE: Reuses the same TaskDelegated event pattern as AgentExitConditionEvaluator.
   * Does NOT use jsonSchema — feedforward doesn't need structured output since we only
   * capture the full output as feedback text.
   */
  private async runEvalAgent(loop: Loop, taskId: TaskId): Promise<string | null> {
    const prompt = await this.buildFindingsPrompt(loop, taskId);

    // Feedforward never injects jsonSchema — we want the full narrative output as findings
    const evalTaskRequest: TaskRequest = {
      prompt: `[EVAL-FEEDFORWARD] ${prompt}`,
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: loop.taskTemplate.agent,
    };
    const evalTask = createTask(evalTaskRequest);
    const evalTaskId = evalTask.id;

    this.logger.info('Starting feedforward eval task', {
      loopId: loop.id,
      evalTaskId,
      workTaskId: taskId,
    });

    // Set up completion listener BEFORE emitting to prevent race conditions
    const completionPromise = this.waitForTaskCompletion(evalTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: evalTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for feedforward eval task', emitResult.error, {
        loopId: loop.id,
        evalTaskId,
      });
      return null;
    }

    const completionStatus = await completionPromise;

    if (completionStatus.type !== 'completed') {
      this.logger.warn('Feedforward eval task did not complete successfully', {
        loopId: loop.id,
        evalTaskId,
        completionStatus: completionStatus.type,
      });
      return null;
    }

    const outputResult = await this.outputRepo.get(evalTaskId);
    if (!outputResult.ok || !outputResult.value) {
      this.logger.warn('Failed to read feedforward eval task output', {
        loopId: loop.id,
        evalTaskId,
        error: outputResult.ok ? 'no output' : outputResult.error.message,
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
   * Build the findings prompt for the feedforward eval agent.
   * Instructs the agent to report findings without making a pass/fail decision.
   */
  private async buildFindingsPrompt(loop: Loop, taskId: TaskId): Promise<string> {
    const base = await buildEvalPromptBase(loop, taskId, this.loopRepo);
    const criteria = loop.evalPrompt ?? 'Review the code changes and provide your observations and findings.';

    return `You are reviewing the result of an automated code improvement iteration.
Provide observations and findings only — do NOT make a pass/fail decision.

${base.contextHeader}

${base.toolInstructions}

${criteria}

Provide your detailed findings. There is no special format required — write naturally.`;
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

/**
 * Composite exit condition evaluator
 *
 * ARCHITECTURE: Two-level eval hierarchy (evalMode + evalType).
 * Why: evalMode (shell/agent) is the top-level; evalType (feedforward/judge/schema)
 * is agent-specific sub-strategy. feedforward is default because it works with any agent.
 *
 * Dispatch table:
 *   evalMode=shell         → shellEvaluator  (shell command evaluation)
 *   evalMode=agent, type=schema      → agentEvaluator  (Claude --json-schema)
 *   evalMode=agent, type=judge       → judgeEvaluator  (two-phase eval+judge)
 *   evalMode=agent, type=feedforward → feedforwardEvaluator (findings only, always continue)
 *   evalMode=agent, type=undefined   → feedforwardEvaluator (default)
 *
 * Pattern: Composite pattern — transparent to callers, implements ExitConditionEvaluator
 */

import type { Loop, TaskId } from '../core/domain.js';
import { EvalMode, EvalType } from '../core/domain.js';
import type { EvalResult, ExitConditionEvaluator } from '../core/interfaces.js';

export class CompositeExitConditionEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly shellEvaluator: ExitConditionEvaluator,
    private readonly agentEvaluator: ExitConditionEvaluator,
    private readonly judgeEvaluator: ExitConditionEvaluator,
    private readonly feedforwardEvaluator: ExitConditionEvaluator,
  ) {}

  /**
   * Route evaluation to the appropriate sub-evaluator.
   *
   * DECISION: feedforward is the default evalType for agent mode.
   * Why: feedforward works with any agent and never blocks iteration — it's the safest
   * default. schema only works with Claude; judge requires explicit judgeAgent config.
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    if (loop.evalMode === EvalMode.SHELL) {
      return this.shellEvaluator.evaluate(loop, taskId);
    }

    // evalMode === 'agent' — route by evalType (default: feedforward)
    const evalType = loop.evalType ?? EvalType.FEEDFORWARD;

    switch (evalType) {
      case EvalType.SCHEMA:
        return this.agentEvaluator.evaluate(loop, taskId);
      case EvalType.JUDGE:
        return this.judgeEvaluator.evaluate(loop, taskId);
      case EvalType.FEEDFORWARD:
        return this.feedforwardEvaluator.evaluate(loop, taskId);
      default: {
        // Exhaustiveness guard — new EvalType values will cause a compile error here
        const _exhaustive: never = evalType;
        // Throw at runtime — silent fallback masks misconfiguration
        throw new Error(`Unhandled evalType: ${String(_exhaustive)}`);
      }
    }
  }
}

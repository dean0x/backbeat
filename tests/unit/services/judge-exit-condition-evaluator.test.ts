/**
 * Unit tests for JudgeExitConditionEvaluator
 *
 * ARCHITECTURE: Uses injected FsAdapter mock rather than vi.mock('node:fs/promises').
 *
 * DECISION: Inject fs dependency rather than vi.mock at file scope.
 * Why: vi.mock('node:fs/promises') leaks through vitest's shared module registry in
 * --no-file-parallelism runs. When handler-setup.test.ts runs, it imports handler-setup.ts
 * which instantiates JudgeExitConditionEvaluator, loading the real node:fs/promises into
 * the module cache. This clobbers the vi.mock regardless of file run order.
 * DI injection (optional 5th constructor param) is the clean solution — no module-level
 * mocking required, and the production code defaults to the real fs when no mock is passed.
 *
 * Pattern: Behavioral testing — verifies file-based judge decision mechanism,
 * two-phase eval+judge flow, safe fallbacks, and schema injection for Claude.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../../src/core/domain.js';
import { createLoop, EvalMode, LoopStrategy, TaskId } from '../../../src/core/domain.js';
import type { EvalResult, LoopRepository, OutputRepository } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import type { FsAdapter } from '../../../src/services/judge-exit-condition-evaluator.js';
import { JudgeExitConditionEvaluator } from '../../../src/services/judge-exit-condition-evaluator.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockFs(): { readFile: ReturnType<typeof vi.fn>; unlink: ReturnType<typeof vi.fn> } & FsAdapter {
  return {
    readFile: vi.fn().mockResolvedValue(''),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
}

function createOutputRepo(lines: string[]): OutputRepository {
  return {
    get: vi.fn().mockResolvedValue(
      ok({
        stdout: lines,
        stderr: [],
        truncated: false,
        byteSize: lines.join('\n').length,
      }),
    ),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    getByteSize: vi.fn().mockResolvedValue(ok(0)),
  } as unknown as OutputRepository;
}

function createLoopRepo(): LoopRepository {
  return {
    findIterationByTaskId: vi.fn().mockResolvedValue(ok(null)),
    findById: vi.fn().mockResolvedValue(ok(null)),
    findAll: vi.fn().mockResolvedValue(ok([])),
    findByStatus: vi.fn().mockResolvedValue(ok([])),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    updateStatus: vi.fn().mockResolvedValue(ok(undefined)),
    recordIteration: vi.fn().mockResolvedValue(ok(undefined)),
    updateIteration: vi.fn().mockResolvedValue(ok(undefined)),
    getIterations: vi.fn().mockResolvedValue(ok([])),
    saveSync: vi.fn().mockReturnValue(ok(undefined)),
    updateStatusSync: vi.fn().mockReturnValue(ok(undefined)),
    recordIterationSync: vi.fn().mockReturnValue(ok(undefined)),
    updateIterationSync: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as LoopRepository;
}

function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
  return createLoop(
    {
      prompt: 'Improve the code quality',
      strategy: LoopStrategy.RETRY,
      exitCondition: '',
      evalMode: EvalMode.AGENT,
      maxIterations: 5,
      evalTimeout: 10000,
      ...overrides,
    },
    '/workspace',
  );
}

async function evaluateWithCompletions(
  evaluator: JudgeExitConditionEvaluator,
  loop: Loop,
  taskId: ReturnType<typeof TaskId>,
  eventBus: TestEventBus,
  simulateFns: Array<(evalTaskId: string) => Promise<void>>,
): Promise<EvalResult> {
  const capturedTaskIds: string[] = [];
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
    if (type === 'TaskDelegated') {
      capturedTaskIds.push((payload as { task: { id: string } }).task.id);
    }
    return origEmit(type as never, payload as never);
  });

  const evalPromise = evaluator.evaluate(loop, taskId);

  for (let i = 0; i < simulateFns.length; i++) {
    await new Promise((r) => setImmediate(r));
    const taskIdForPhase = capturedTaskIds[i];
    if (taskIdForPhase) {
      await simulateFns[i](taskIdForPhase);
    }
    await new Promise((r) => setImmediate(r));
  }

  return evalPromise;
}

async function simulateTaskComplete(eventBus: TestEventBus, taskId: string): Promise<void> {
  await eventBus.emit('TaskCompleted', {
    taskId: taskId as ReturnType<typeof TaskId>,
    workerId: 'w1' as unknown as never,
  });
}

async function simulateTaskFailed(eventBus: TestEventBus, taskId: string): Promise<void> {
  await eventBus.emit('TaskFailed', {
    taskId: taskId as ReturnType<typeof TaskId>,
    error: new Error('task failed'),
    workerId: 'w1' as unknown as never,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('JudgeExitConditionEvaluator', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;
  const workTaskId = TaskId('task-work-xyz789');

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventBus.dispose();
  });

  it('returns decision: stop when judge file contains continue: false', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes', judgePrompt: 'Should we stop?' });
    const outputRepo = createOutputRepo(['Analysis: tests are passing.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: false, reasoning: 'All criteria met.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('stop');
    expect(result.feedback).toBeTruthy();
  });

  it('returns decision: continue when judge file contains continue: true', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['Tests still failing.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: true, reasoning: 'More work needed.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('defaults to continue when judge file is missing (ENOENT)', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['No verdict.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('defaults to continue when judge file contains invalid JSON', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['Some output.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce('not valid json at all!!!!');
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('defaults to continue when judge phase 2 task fails', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['Output here.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskFailed(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('includes findings (phase 1 output) in feedback', async () => {
    const loop = createTestLoop({ evalPrompt: 'Evaluate test quality' });
    const outputRepo = createOutputRepo(['Coverage is at 80%.', 'Three tests still failing.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: true, reasoning: 'Keep going.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.feedback).toContain('Coverage is at 80%.');
    expect(result.feedback).toContain('Three tests still failing.');
  });

  it('injects jsonSchema for Claude judge agent (belt-and-suspenders)', async () => {
    const loop = createTestLoop({
      evalPrompt: 'Review',
      judgeAgent: 'claude',
    });
    const outputRepo = createOutputRepo(['Findings.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{
      task: { prompt: string; jsonSchema?: string; agent: string };
    }>;
    const judgeEvent = delegatedEvents.find((e) => e.task.prompt.startsWith('[JUDGE]'));
    expect(judgeEvent).toBeDefined();
    expect(judgeEvent?.task.jsonSchema).toBeTruthy();
  });

  it('does not inject jsonSchema for non-Claude judge agent', async () => {
    const loop = createTestLoop({
      evalPrompt: 'Review',
      judgeAgent: 'gemini',
    });
    const outputRepo = createOutputRepo(['Findings.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{
      task: { prompt: string; jsonSchema?: string };
    }>;
    const judgeEvent = delegatedEvents.find((e) => e.task.prompt.startsWith('[JUDGE]'));
    expect(judgeEvent?.task.jsonSchema).toBeUndefined();
  });

  it('stores evalResponse with judgeDecision and evalFindings', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review' });
    const outputRepo = createOutputRepo(['Good progress.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: false, reasoning: 'Done.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.evalResponse).toBeTruthy();
    const parsed = JSON.parse(result.evalResponse!);
    expect(parsed.judgeDecision).toBeDefined();
    expect(parsed.judgeDecision.continue).toBe(false);
    expect(parsed.evalFindings).toBeTruthy();
  });

  it('uses structured output from Claude judge when available (bypasses file read)', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review', judgeAgent: 'claude' });
    const structuredOutput = JSON.stringify({
      type: 'result',
      structured_output: { continue: false, reasoning: 'Structured: complete.' },
    });
    const outputRepoPhase1 = createOutputRepo(['Findings.']);
    const outputRepoPhase2 = createOutputRepo([structuredOutput]);
    let callCount = 0;
    const combinedOutputRepo: OutputRepository = {
      get: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1
          ? outputRepoPhase1.get(undefined as unknown as ReturnType<typeof TaskId>)
          : outputRepoPhase2.get(undefined as unknown as ReturnType<typeof TaskId>);
      }),
      save: vi.fn().mockResolvedValue(ok(undefined)),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      getByteSize: vi.fn().mockResolvedValue(ok(0)),
    } as unknown as OutputRepository;
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const evaluator = new JudgeExitConditionEvaluator(eventBus, combinedOutputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('stop');
  });
});

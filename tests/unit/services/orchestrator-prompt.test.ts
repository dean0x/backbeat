/**
 * Unit tests for orchestrator prompt builder
 * ARCHITECTURE: Tests pure function output for correct content
 */

import { describe, expect, it } from 'vitest';
import { buildOrchestratorPrompt } from '../../../src/services/orchestrator-prompt.js';

describe('buildOrchestratorPrompt - Unit Tests', () => {
  const defaultParams = {
    goal: 'Build a complete authentication system',
    stateFilePath: '/home/user/.autobeat/orchestrator-state/state-123.json',
    workingDirectory: '/workspace/my-project',
    maxDepth: 3,
    maxWorkers: 5,
  };

  it('should include the goal in the prompt', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('Build a complete authentication system');
  });

  it('should include the state file path', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('/home/user/.autobeat/orchestrator-state/state-123.json');
  });

  it('should include the working directory', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('/workspace/my-project');
  });

  it('should include beat CLI commands', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('beat run');
    expect(prompt).toContain('beat status');
    expect(prompt).toContain('beat logs');
    expect(prompt).toContain('beat cancel');
  });

  it('should include maxWorkers constraint', () => {
    const prompt = buildOrchestratorPrompt({ ...defaultParams, maxWorkers: 10 });
    expect(prompt).toContain('Max concurrent workers: 10');
  });

  it('should include maxDepth constraint', () => {
    const prompt = buildOrchestratorPrompt({ ...defaultParams, maxDepth: 7 });
    expect(prompt).toContain('Max delegation depth: 7');
  });

  it('should include decision protocol', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('DECISION PROTOCOL');
    expect(prompt).toContain('PLANNING');
    expect(prompt).toContain('EXECUTING');
    expect(prompt).toContain('MONITORING');
    expect(prompt).toContain('VALIDATION');
    expect(prompt).toContain('COMPLETION');
  });

  it('should include resilience instructions', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('RESILIENCE');
    expect(prompt).toContain('state file is missing');
    expect(prompt).toContain('status: "failed"');
  });

  it('should include conflict avoidance', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('CONFLICT AVOIDANCE');
    expect(prompt).toContain('integration validation task');
  });
});

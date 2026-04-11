/**
 * Tests for CountsPanel component
 * ARCHITECTURE: Tests behavior — nested counts render, all entity kinds
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { CountsPanel } from '../../../../src/cli/dashboard/components/counts-panel.js';

describe('CountsPanel', () => {
  const defaultCounts = {
    orchestrations: { running: 2, completed: 5, failed: 1 },
    loops: { running: 1, completed: 3, failed: 0 },
    tasks: { running: 4, completed: 12, failed: 2 },
    schedules: { running: 0, completed: 1, failed: 0 },
  };

  describe('entity sections', () => {
    it('renders orchestrations section', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()?.toLowerCase()).toContain('orch');
    });

    it('renders loops section', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()?.toLowerCase()).toContain('loop');
    });

    it('renders tasks section', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()?.toLowerCase()).toContain('task');
    });

    it('renders schedules section', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()?.toLowerCase()).toContain('sched');
    });
  });

  describe('count values', () => {
    it('shows running count for orchestrations', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()).toContain('2');
    });

    it('shows completed count for tasks', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()).toContain('12');
    });

    it('shows failed count', () => {
      const { lastFrame } = render(<CountsPanel counts={defaultCounts} />);
      expect(lastFrame()).toContain('1'); // orch failed=1
    });
  });

  describe('zero state', () => {
    it('renders without crashing when all counts are zero', () => {
      const zeroCounts = {
        orchestrations: { running: 0, completed: 0, failed: 0 },
        loops: { running: 0, completed: 0, failed: 0 },
        tasks: { running: 0, completed: 0, failed: 0 },
        schedules: { running: 0, completed: 0, failed: 0 },
      };
      const { lastFrame } = render(<CountsPanel counts={zeroCounts} />);
      expect(lastFrame()).toBeTruthy();
    });
  });
});

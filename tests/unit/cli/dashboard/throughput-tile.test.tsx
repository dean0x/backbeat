/**
 * Tests for ThroughputTile component
 * ARCHITECTURE: Tests behavior — number formatting, duration display
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ThroughputTile } from '../../../../src/cli/dashboard/components/throughput-tile.js';

describe('ThroughputTile', () => {
  const defaultStats = {
    tasksPerHour: 12,
    loopsPerHour: 3,
    successRate: 0.875,
    avgDurationMs: 125_000,
  };

  describe('tasks and loops per hour', () => {
    it('shows tasks per hour', () => {
      const { lastFrame } = render(<ThroughputTile stats={defaultStats} />);
      expect(lastFrame()).toContain('12');
    });

    it('shows loops per hour', () => {
      const { lastFrame } = render(<ThroughputTile stats={defaultStats} />);
      expect(lastFrame()).toContain('3');
    });
  });

  describe('success rate', () => {
    it('shows success rate as percentage', () => {
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, successRate: 0.875 }} />);
      // 87.5% or 88%
      expect(lastFrame()).toMatch(/87|88/);
    });

    it('shows 100% for perfect success rate', () => {
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, successRate: 1.0 }} />);
      expect(lastFrame()).toContain('100');
    });

    it('shows 0% for zero success rate', () => {
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, successRate: 0 }} />);
      expect(lastFrame()).toContain('0');
    });
  });

  describe('duration formatting', () => {
    it('formats average duration in minutes and seconds', () => {
      // 125_000ms = 2m 5s
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, avgDurationMs: 125_000 }} />);
      expect(lastFrame()).toContain('2m');
      expect(lastFrame()).toContain('5s');
    });

    it('formats sub-minute duration as seconds only', () => {
      // 45_000ms = 45s
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, avgDurationMs: 45_000 }} />);
      expect(lastFrame()).toContain('45s');
    });

    it('formats zero duration', () => {
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, avgDurationMs: 0 }} />);
      expect(lastFrame()).toContain('0s');
    });

    it('formats large duration in minutes and seconds', () => {
      // 3600_000ms = 60m 0s
      const { lastFrame } = render(<ThroughputTile stats={{ ...defaultStats, avgDurationMs: 3_600_000 }} />);
      expect(lastFrame()).toContain('60m');
    });
  });

  describe('zero state', () => {
    it('renders without crashing when all stats are zero', () => {
      const { lastFrame } = render(
        <ThroughputTile stats={{ tasksPerHour: 0, loopsPerHour: 0, successRate: 0, avgDurationMs: 0 }} />,
      );
      expect(lastFrame()).toBeTruthy();
    });
  });
});

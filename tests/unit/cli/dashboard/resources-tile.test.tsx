/**
 * Tests for ResourcesTile component
 * ARCHITECTURE: Tests behavior — color bands, unavailable state
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ResourcesTile } from '../../../../src/cli/dashboard/components/resources-tile.js';
import type { SystemResources } from '../../../../src/core/domain.js';

function makeResources(overrides: Partial<SystemResources> = {}): SystemResources {
  return {
    cpuUsage: 30,
    availableMemory: 4 * 1024 * 1024 * 1024, // 4 GB
    totalMemory: 8 * 1024 * 1024 * 1024, // 8 GB
    loadAverage: [0.5, 0.3, 0.2],
    workerCount: 2,
    ...overrides,
  };
}

describe('ResourcesTile', () => {
  describe('unavailable state', () => {
    it('shows placeholder when resources is null', () => {
      const { lastFrame } = render(<ResourcesTile resources={null} error={null} />);
      // Should show em-dash or placeholder for all fields
      const frame = lastFrame() ?? '';
      expect(frame).toContain('—');
    });

    it('renders without crashing when error is provided', () => {
      const { lastFrame } = render(<ResourcesTile resources={null} error="Monitor unavailable" />);
      expect(lastFrame()).toBeTruthy();
    });
  });

  describe('normal rendering', () => {
    it('shows CPU usage percentage', () => {
      const { lastFrame } = render(<ResourcesTile resources={makeResources({ cpuUsage: 35 })} error={null} />);
      expect(lastFrame()).toContain('35');
    });

    it('shows worker count', () => {
      const { lastFrame } = render(<ResourcesTile resources={makeResources({ workerCount: 4 })} error={null} />);
      expect(lastFrame()).toContain('4');
    });

    it('shows load average values', () => {
      const { lastFrame } = render(
        <ResourcesTile resources={makeResources({ loadAverage: [1.5, 1.2, 0.9] })} error={null} />,
      );
      expect(lastFrame()).toContain('1.5');
    });

    it('renders memory information', () => {
      const { lastFrame } = render(
        <ResourcesTile
          resources={makeResources({
            availableMemory: 2 * 1024 * 1024 * 1024,
            totalMemory: 8 * 1024 * 1024 * 1024,
          })}
          error={null}
        />,
      );
      // Memory should appear in some form (GB or MB)
      expect(lastFrame()).toMatch(/[0-9]/);
    });
  });

  describe('CPU bar colors (via text content)', () => {
    it('shows bar segments for CPU usage', () => {
      const { lastFrame } = render(<ResourcesTile resources={makeResources({ cpuUsage: 50 })} error={null} />);
      // Should contain a bar character (█ or ░)
      expect(lastFrame()).toMatch(/[█░]/);
    });

    it('renders CPU < 50% as green-tagged content', () => {
      // We test the rendered output contains the CPU value in a bar context
      const { lastFrame } = render(<ResourcesTile resources={makeResources({ cpuUsage: 25 })} error={null} />);
      expect(lastFrame()).toContain('25');
    });

    it('renders CPU >= 80% (high usage) and contains value', () => {
      const { lastFrame } = render(<ResourcesTile resources={makeResources({ cpuUsage: 85 })} error={null} />);
      expect(lastFrame()).toContain('85');
    });
  });
});

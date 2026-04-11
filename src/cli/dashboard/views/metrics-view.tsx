/**
 * MetricsView — redesigned main view for view.kind === 'main'
 * ARCHITECTURE: Stateless view component — all data from props
 * Pattern: Functional core — composes tiles (top row) + panels (bottom row)
 *
 * Layout is driven by MetricsLayout from computeMetricsLayout().
 * Degraded modes:
 *   - 'too-small': show resize message
 *   - 'narrow': single-column stack
 *   - 'full': normal tile + panel layout
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { SystemResources } from '../../../core/domain.js';
import { ActivityPanel } from '../components/activity-panel.js';
import { CostTile } from '../components/cost-tile.js';
import { CountsPanel } from '../components/counts-panel.js';
import { ResourcesTile } from '../components/resources-tile.js';
import { ThroughputTile } from '../components/throughput-tile.js';
import type { MetricsLayout } from '../layout.js';
import type { DashboardData, NavState } from '../types.js';

// Zero-value placeholders for when data is not yet available
const ZERO_USAGE = {
  taskId: '' as never,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
  capturedAt: 0,
};

const ZERO_THROUGHPUT = {
  tasksPerHour: 0,
  loopsPerHour: 0,
  successRate: 0,
  avgDurationMs: 0,
};

interface MetricsViewProps {
  readonly layout: MetricsLayout;
  readonly data: DashboardData | null;
  readonly nav: NavState;
  readonly resourceMetrics: SystemResources | null;
  readonly resourceError: string | null;
}

// ============================================================================
// Counts extraction helper
// ============================================================================

interface CountsShape {
  running: number;
  completed: number;
  failed: number;
}

function extractGroup(byStatus: Record<string, number>): CountsShape {
  return {
    running: byStatus['running'] ?? byStatus['planning'] ?? 0,
    completed: byStatus['completed'] ?? 0,
    failed: byStatus['failed'] ?? 0,
  };
}

// ============================================================================
// MetricsView
// ============================================================================

export const MetricsView: React.FC<MetricsViewProps> = React.memo(
  ({ layout, data, nav, resourceMetrics, resourceError }) => {
    // Degraded mode: terminal too small
    if (layout.mode === 'too-small') {
      return (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color="yellow">Resize terminal to view metrics (need ≥60 cols × 14 rows)</Text>
        </Box>
      );
    }

    // Degraded mode: narrow terminal — single column stack
    if (layout.mode === 'narrow') {
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Text dimColor>Narrow terminal — expand to see full dashboard</Text>
          <ResourcesTile resources={resourceMetrics} error={resourceError} />
          <CostTile costRollup24h={data?.costRollup24h ?? ZERO_USAGE} top={data?.topOrchestrationsByCost ?? []} />
        </Box>
      );
    }

    // Full metrics layout
    const activityFeed = data?.activityFeed ?? [];
    const topOrchestrationsByCost = data?.topOrchestrationsByCost ?? [];
    const costRollup24h = data?.costRollup24h ?? ZERO_USAGE;
    const throughputStats = data?.throughputStats ?? ZERO_THROUGHPUT;

    const counts = {
      orchestrations: extractGroup(data?.orchestrationCounts.byStatus ?? {}),
      loops: extractGroup(data?.loopCounts.byStatus ?? {}),
      tasks: extractGroup(data?.taskCounts.byStatus ?? {}),
      schedules: extractGroup(data?.scheduleCounts.byStatus ?? {}),
    };

    return (
      <Box flexDirection="column" flexGrow={1}>
        {/* Top row: tiles */}
        <Box flexDirection="row" height={layout.topRowHeight}>
          <ResourcesTile resources={resourceMetrics} error={resourceError} />
          <CostTile costRollup24h={costRollup24h} top={topOrchestrationsByCost} />
          <ThroughputTile stats={throughputStats} />
        </Box>

        {/* Bottom row: activity panel + counts panel */}
        <Box flexDirection="row" flexGrow={1}>
          <ActivityPanel
            activityFeed={activityFeed}
            selectedIndex={nav.selectedIndices.tasks}
            scrollOffset={nav.scrollOffsets.tasks}
            focused={nav.focusedPanel === 'tasks'}
            onSelect={() => {
              // Phase E will wire this to navigation — placeholder for now
            }}
          />
          <CountsPanel counts={counts} />
        </Box>
      </Box>
    );
  },
);

MetricsView.displayName = 'MetricsView';

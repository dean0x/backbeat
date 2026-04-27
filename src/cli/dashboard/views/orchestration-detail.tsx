/**
 * OrchestrationDetail — full-screen orchestration detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Phase E additions:
 *  - Children list: paginated tasks attributed to this orchestration
 *  - Cost aggregate: total cost/tokens; hidden when all zero (fresh orch)
 *
 * D3 drill-through (v1.3.0):
 *  - ScrollableList with selection highlighting
 *  - Pagination footer when total > page size
 *  - Enter on selected row → navigate to task detail
 *
 * Phase C additions:
 *  - Progress Indicators: depth/workers/children vs config limits
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Orchestration, OrchestratorChild, TaskUsage } from '../../../core/domain.js';
import { Field, LongField, StatusField } from '../components/field.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { relativeTime, truncateCell } from '../format.js';

/** Page size for the children list — matches ORCHESTRATION_CHILDREN_PAGE_SIZE in use-dashboard-data */
export const ORCHESTRATION_CHILDREN_PAGE_SIZE = 15;

interface OrchestrationDetailProps {
  readonly orchestration: Orchestration;
  readonly animFrame?: number;
  /** Children tasks attributed to this orchestration (current page). Default: [] */
  readonly children?: readonly OrchestratorChild[];
  /** Aggregated cost/token usage; undefined or all-zero = hidden */
  readonly costAggregate?: TaskUsage;
  /** TaskId of the currently highlighted child row (null or undefined = highlight first) */
  readonly childSelectedTaskId?: string | null;
  /** 0-based page number for pagination footer */
  readonly currentPage?: number;
  /** Total count of all children (across all pages) for pagination footer */
  readonly childrenTotal?: number;
}

/**
 * Render a single child row with optional selection highlight.
 */
function renderChildRow(child: OrchestratorChild, _index: number, isSelected: boolean): React.ReactNode {
  const shortId = child.taskId.slice(0, 12);
  const kind = child.kind === 'direct' ? 'direct' : 'iter  ';
  const status = child.status.toString().slice(0, 10).padEnd(10);
  const agent = (child.agent ?? '—').slice(0, 8).padEnd(8);
  const promptPreview = child.prompt.slice(0, 40).replace(/\n/g, ' ');

  const line = `${shortId}  ${kind}  ${status}  ${agent}  ${promptPreview}`;

  return (
    <Text color={isSelected ? 'blue' : undefined} inverse={isSelected} dimColor={!isSelected}>
      {line}
    </Text>
  );
}

/**
 * Cost section — hidden when totalCostUsd === 0 and inputTokens === 0.
 */
function CostSection({ costAggregate }: { readonly costAggregate: TaskUsage | undefined }): React.ReactElement | null {
  if (!costAggregate) return null;
  if (costAggregate.totalCostUsd === 0 && costAggregate.inputTokens === 0) return null;

  const costStr = `$${costAggregate.totalCostUsd.toFixed(2)}`;
  const cacheTokens = (costAggregate.cacheCreationInputTokens ?? 0) + (costAggregate.cacheReadInputTokens ?? 0);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        Cost
      </Text>
      <Field label="Total">{costStr}</Field>
      <Field label="Tokens in">{String(costAggregate.inputTokens)}</Field>
      <Field label="Tokens out">{String(costAggregate.outputTokens)}</Field>
      {cacheTokens > 0 && <Field label="Cache">{`${cacheTokens} tokens`}</Field>}
    </Box>
  );
}

/**
 * Progress indicators — shown when orchestration has configuration limits.
 * Depth is approximated from children data (not exact tree traversal).
 * DECISION: Workers = running children count; Children = total vs maxTasks limit.
 */
function ProgressSection({
  orchestration,
  children,
  childrenTotal,
}: {
  readonly orchestration: Orchestration;
  readonly children: readonly OrchestratorChild[];
  readonly childrenTotal: number | undefined;
}): React.ReactElement | null {
  const totalChildren = childrenTotal ?? children.length;
  const hasLimits = orchestration.maxDepth > 0 || orchestration.maxWorkers > 0 || orchestration.maxIterations > 0;
  const hasChildrenData = totalChildren > 0;
  if (!hasLimits && !hasChildrenData) return null;

  // Count running children as active workers
  const runningWorkers = children.filter((c) => c.status === 'running').length;

  const parts: string[] = [];
  if (orchestration.maxWorkers > 0) {
    parts.push(`Workers ${runningWorkers}/${orchestration.maxWorkers}`);
  }
  if (orchestration.maxIterations > 0) {
    parts.push(`Iterations ${orchestration.maxIterations} max`);
  }
  if (totalChildren > 0 || childrenTotal !== undefined) {
    parts.push(`Children ${totalChildren}`);
  }

  if (parts.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        Progress
      </Text>
      <Field label="Status">{parts.join(' · ')}</Field>
    </Box>
  );
}

export const OrchestrationDetail: React.FC<OrchestrationDetailProps> = React.memo(
  ({
    orchestration,
    animFrame = 0,
    children = [],
    costAggregate,
    childSelectedTaskId,
    currentPage = 0,
    childrenTotal,
  }) => {
    // Compute selected index: by taskId for stability across refetches; fallback to 0.
    const selectedIndex = React.useMemo(() => {
      if (!childSelectedTaskId || children.length === 0) return 0;
      const idx = children.findIndex((c) => c.taskId === childSelectedTaskId);
      return idx >= 0 ? idx : 0;
    }, [children, childSelectedTaskId]);

    const showPaginationFooter = childrenTotal !== undefined && childrenTotal > children.length && children.length > 0;
    const totalPages = childrenTotal !== undefined ? Math.ceil(childrenTotal / ORCHESTRATION_CHILDREN_PAGE_SIZE) : 1;

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Header */}
        <Box marginBottom={1}>
          <Text bold>Orchestration Detail</Text>
        </Box>

        <Field label="ID">{truncateCell(orchestration.id, 60)}</Field>
        <StatusField>
          <StatusBadge status={orchestration.status} animFrame={animFrame} />
        </StatusField>

        {/* Goal (full, wrapped) */}
        <LongField label="Goal" value={orchestration.goal} />

        {orchestration.agent ? <Field label="Agent">{orchestration.agent}</Field> : null}
        {orchestration.model ? <Field label="Model">{orchestration.model}</Field> : null}
        {orchestration.loopId ? <Field label="Loop ID">{truncateCell(orchestration.loopId, 50)}</Field> : null}
        <Field label="Max Depth">{String(orchestration.maxDepth)}</Field>
        <Field label="Max Workers">{String(orchestration.maxWorkers)}</Field>
        <Field label="Max Iterations">{String(orchestration.maxIterations)}</Field>
        <Field label="Working Directory">{truncateCell(orchestration.workingDirectory, 50)}</Field>
        <Field label="State File">{truncateCell(orchestration.stateFilePath, 50)}</Field>
        <Field label="Created">{relativeTime(orchestration.createdAt)}</Field>
        <Field label="Updated">{relativeTime(orchestration.updatedAt)}</Field>
        {orchestration.completedAt !== undefined ? (
          <Field label="Completed">{relativeTime(orchestration.completedAt)}</Field>
        ) : null}

        {/* Cost aggregate — only shown when there is actual usage data */}
        <CostSection costAggregate={costAggregate} />

        {/* Progress indicators — only shown when the orchestration has configuration limits */}
        <ProgressSection orchestration={orchestration} children={children} childrenTotal={childrenTotal} />

        {/* Children section — only shown when the orchestration has attributed tasks */}
        {children.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              {`Children (${childrenTotal ?? children.length})`}
            </Text>
            <ScrollableList
              items={children}
              selectedIndex={selectedIndex}
              scrollOffset={0}
              viewportHeight={ORCHESTRATION_CHILDREN_PAGE_SIZE}
              renderItem={renderChildRow}
              keyExtractor={(child) => child.taskId}
            />
            {/* Pagination footer — only shown when multiple pages exist */}
            {showPaginationFooter && (
              <Box marginTop={1}>
                <Text dimColor>
                  {`Page ${currentPage + 1} of ${totalPages} · PgUp/PgDn to navigate · ${childrenTotal} total · Enter to drill in`}
                </Text>
              </Box>
            )}
            {/* Drill hint on single page */}
            {!showPaginationFooter && children.length > 0 && (
              <Box marginTop={1}>
                <Text dimColor>Enter to drill into child task detail</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    );
  },
);

OrchestrationDetail.displayName = 'OrchestrationDetail';

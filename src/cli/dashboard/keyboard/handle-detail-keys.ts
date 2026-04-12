/**
 * Key handler for the detail view.
 *
 * Scope: view.kind === 'detail'. Handles Esc/Backspace to return to the
 * previous view, D3 orchestration drill-through child row navigation
 * (↑/↓/Enter/PgUp/PgDn), and scroll for non-orchestration detail content.
 */

import type { TaskId } from '../../../core/domain.js';
import { ORCHESTRATION_CHILDREN_PAGE_SIZE } from '../views/orchestration-detail.js';
import { resolveChildIndex } from './helpers.js';
import type { InkKey, KeyHandlerParams } from './types.js';

/**
 * Handle key input while in the detail view.
 * Returns true if the key was consumed.
 *
 * D3 drill-through (v1.3.0):
 *  - Orchestration detail: ↑/↓/j/k move child row selection (by taskId)
 *  - Enter: drill into selected child's task detail (returnTo = orchestration object)
 *  - PgUp/PgDn: navigate pages of children (resets selection to first row on page)
 *  - Esc/Backspace: returns to the view encoded in returnTo (main, workspace, or orchestration)
 *
 * For non-orchestration detail views, ↑/↓ scroll the detail content as before.
 */
export function handleDetailKeys(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { view, nav, setView, setNav, detailContentLength, refreshNow } = params;
  if (view.kind !== 'detail') return false;

  if (key.escape || key.backspace) {
    // Return to the view that opened this detail (returnTo defaults to 'main')
    const returnTo = view.returnTo ?? 'main';
    if (typeof returnTo === 'object' && returnTo.kind === 'orchestrations') {
      // D3 drill-through Esc: return to the parent orchestration detail
      setView({
        kind: 'detail',
        entityType: 'orchestrations',
        entityId: returnTo.entityId,
        returnTo: returnTo.originalReturnTo,
      });
    } else if (returnTo === 'workspace') {
      setView({ kind: 'workspace' });
    } else {
      setView({ kind: 'main' });
    }
    return true;
  }

  // D3 orchestration detail: child row navigation + drill-through
  if (view.entityType === 'orchestrations') {
    const children = params.dataRef.current?.orchestrationChildren ?? [];
    const childrenTotal = params.dataRef.current?.orchestrationChildrenTotal;

    if (key.upArrow || input === 'k') {
      if (children.length === 0) return true;
      setNav((prev) => {
        const nextIdx = Math.max(0, resolveChildIndex(prev.orchestrationChildSelectedTaskId, children) - 1);
        return { ...prev, orchestrationChildSelectedTaskId: children[nextIdx]?.taskId ?? null };
      });
      return true;
    }

    if (key.downArrow || input === 'j') {
      if (children.length === 0) return true;
      setNav((prev) => {
        const nextIdx = Math.min(
          children.length - 1,
          resolveChildIndex(prev.orchestrationChildSelectedTaskId, children) + 1,
        );
        return { ...prev, orchestrationChildSelectedTaskId: children[nextIdx]?.taskId ?? null };
      });
      return true;
    }

    if (key.return) {
      // Enter: drill into the selected child task detail
      if (children.length === 0) return true;
      const child = children[resolveChildIndex(nav.orchestrationChildSelectedTaskId, children)];
      if (!child) return true;
      const originalReturnTo: 'main' | 'workspace' = view.returnTo === 'workspace' ? 'workspace' : 'main';
      setView({
        kind: 'detail',
        entityType: 'tasks',
        entityId: child.taskId as TaskId,
        returnTo: {
          kind: 'orchestrations',
          entityId: view.entityId,
          originalReturnTo,
        },
      });
      return true;
    }

    if (key.pageUp) {
      setNav((prev) => {
        const newPage = Math.max(0, prev.orchestrationChildPage - 1);
        if (newPage === prev.orchestrationChildPage) return prev;
        return { ...prev, orchestrationChildPage: newPage, orchestrationChildSelectedTaskId: null };
      });
      // The useDashboardData effect auto-refetches when orchestrationChildPage
      // changes; refreshNow() is called as a belt-and-braces signal so any
      // listener (telemetry, manual indicator) also sees the page-change event.
      refreshNow();
      return true;
    }

    if (key.pageDown) {
      const totalPages = childrenTotal !== undefined ? Math.ceil(childrenTotal / ORCHESTRATION_CHILDREN_PAGE_SIZE) : 1;
      setNav((prev) => {
        const newPage = Math.min(totalPages - 1, prev.orchestrationChildPage + 1);
        if (newPage === prev.orchestrationChildPage) return prev;
        return { ...prev, orchestrationChildPage: newPage, orchestrationChildSelectedTaskId: null };
      });
      refreshNow();
      return true;
    }

    // Any other key in orchestration detail is swallowed
    return true;
  }

  // Non-orchestration detail: ↑/↓ scroll the content
  if (key.upArrow || input === 'k') {
    setNav((prev) => ({
      ...prev,
      scrollOffsets: {
        ...prev.scrollOffsets,
        [view.entityType]: Math.max(0, prev.scrollOffsets[view.entityType] - 1),
      },
    }));
    return true;
  }

  if (key.downArrow || input === 'j') {
    // Clamp to detailContentLength - 1 so the user cannot scroll into empty space
    const maxScroll = Math.max(0, detailContentLength - 1);
    setNav((prev) => ({
      ...prev,
      scrollOffsets: {
        ...prev.scrollOffsets,
        [view.entityType]: Math.min(maxScroll, prev.scrollOffsets[view.entityType] + 1),
      },
    }));
    return true;
  }

  // Any other key in detail view is swallowed (no fallthrough to main handler)
  return true;
}

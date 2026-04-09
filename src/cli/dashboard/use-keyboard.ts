/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 */

import { useInput } from 'ink';
import type React from 'react';
import { useRef } from 'react';
import type { LoopId, OrchestratorId, ScheduleId, TaskId } from '../../core/domain.js';
import type { DashboardData, NavState, PanelId, ViewState } from './types.js';

/**
 * Minimal shape required for navigation — id and status are the only fields
 * the keyboard hook needs to operate on any entity list.
 */
interface Identifiable {
  readonly id: string;
  readonly status: string;
}

/** Ordered panel cycle for Tab navigation */
const PANEL_ORDER: readonly PanelId[] = ['loops', 'tasks', 'schedules', 'orchestrations'];

/** Cycled filter states — covers all statuses across tasks, schedules, loops, and orchestrations */
const FILTER_CYCLE: readonly (string | null)[] = [
  null,
  'running',
  'active',
  'queued',
  'planning',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

interface UseKeyboardParams {
  readonly view: ViewState;
  readonly nav: NavState;
  readonly data: DashboardData | null;
  readonly setView: (v: ViewState) => void;
  readonly setNav: React.Dispatch<React.SetStateAction<NavState>>;
  readonly refreshNow: () => void;
  readonly exit: () => void;
}

/**
 * Map a domain entity array to Identifiable items.
 * Explicit mapping avoids type assertions — status enum values are coerced to
 * string via String() so the result is safely assignable to Identifiable[].
 */
function toIdentifiables(
  items: ReadonlyArray<{ id: string; status: { toString(): string } }>,
): readonly Identifiable[] {
  return items.map((item) => ({ id: item.id, status: item.status.toString() }));
}

/** Return a navigation-friendly item list for the given panel. */
function getPanelItems(panelId: PanelId, data: DashboardData): readonly Identifiable[] {
  switch (panelId) {
    case 'loops':
      return toIdentifiables(data.loops);
    case 'tasks':
      return toIdentifiables(data.tasks);
    case 'schedules':
      return toIdentifiables(data.schedules);
    case 'orchestrations':
      return toIdentifiables(data.orchestrations);
  }
}

/**
 * Get the filtered list length for the currently focused panel.
 * Used to clamp selectedIndex after navigation.
 */
function filteredLength(panelId: PanelId, data: DashboardData | null, filterStatus: string | null): number {
  if (data === null) return 0;
  const items = getPanelItems(panelId, data);
  return filterStatus !== null ? items.filter((item) => item.status === filterStatus).length : items.length;
}

/**
 * Clamp a number between min and max (inclusive).
 * Returns min if range is empty.
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Custom hook wrapping Ink's useInput.
 * Routes keys to handlers based on current view (main or detail).
 */
export function useKeyboard({ view, nav, data, setView, setNav, refreshNow, exit }: UseKeyboardParams): void {
  // Keep a ref to the latest data so setNav functional updaters always see
  // current data, not stale closure data from the render that registered useInput.
  const dataRef = useRef(data);
  dataRef.current = data;

  useInput((input, key) => {
    // Global keys
    if (input === 'q') {
      exit();
      return;
    }

    if (input === 'r') {
      refreshNow();
      return;
    }

    // -------------------------------------------------------------------------
    // Detail view keys
    // -------------------------------------------------------------------------
    if (view.kind === 'detail') {
      if (key.escape || key.backspace) {
        setView({ kind: 'main' });
        return;
      }

      if (key.upArrow || input === 'k') {
        setNav((prev) => ({
          ...prev,
          scrollOffsets: {
            ...prev.scrollOffsets,
            [view.entityType]: Math.max(0, prev.scrollOffsets[view.entityType] - 1),
          },
        }));
        return;
      }

      if (key.downArrow || input === 'j') {
        setNav((prev) => ({
          ...prev,
          scrollOffsets: {
            ...prev.scrollOffsets,
            [view.entityType]: prev.scrollOffsets[view.entityType] + 1,
          },
        }));
        return;
      }

      return;
    }

    // -------------------------------------------------------------------------
    // Main view keys
    // -------------------------------------------------------------------------

    // Tab — cycle focus forward
    if (key.tab && !key.shift) {
      setNav((prev) => {
        const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
        const nextIdx = (currentIdx + 1) % PANEL_ORDER.length;
        return { ...prev, focusedPanel: PANEL_ORDER[nextIdx] };
      });
      return;
    }

    // Shift+Tab — cycle focus backward
    if (key.tab && key.shift) {
      setNav((prev) => {
        const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
        const prevIdx = (currentIdx - 1 + PANEL_ORDER.length) % PANEL_ORDER.length;
        return { ...prev, focusedPanel: PANEL_ORDER[prevIdx] };
      });
      return;
    }

    // 1-4 — jump to panel by number
    const PANEL_BY_KEY: Record<string, PanelId> = { '1': 'loops', '2': 'tasks', '3': 'schedules', '4': 'orchestrations' };
    if (input in PANEL_BY_KEY) {
      setNav((prev) => ({ ...prev, focusedPanel: PANEL_BY_KEY[input] as PanelId }));
      return;
    }

    // Up arrow / k — move selection up
    if (key.upArrow || input === 'k') {
      setNav((prev) => {
        const panel = prev.focusedPanel;
        const current = prev.selectedIndices[panel];
        const next = Math.max(0, current - 1);
        // Scroll up if selection moves above visible area
        const scrollOffset = Math.min(prev.scrollOffsets[panel], next);
        return {
          ...prev,
          selectedIndices: { ...prev.selectedIndices, [panel]: next },
          scrollOffsets: { ...prev.scrollOffsets, [panel]: scrollOffset },
        };
      });
      return;
    }

    // Down arrow / j — move selection down
    if (key.downArrow || input === 'j') {
      setNav((prev) => {
        const panel = prev.focusedPanel;
        const length = filteredLength(panel, dataRef.current, prev.filters[panel]);
        const maxIndex = Math.max(0, length - 1);
        const current = prev.selectedIndices[panel];
        const next = clamp(current + 1, 0, maxIndex);
        // Scroll down if selection exceeds viewport
        const viewportHeight = 10;
        const scrollOffset =
          next >= prev.scrollOffsets[panel] + viewportHeight ? next - viewportHeight + 1 : prev.scrollOffsets[panel];
        return {
          ...prev,
          selectedIndices: { ...prev.selectedIndices, [panel]: next },
          scrollOffsets: { ...prev.scrollOffsets, [panel]: scrollOffset },
        };
      });
      return;
    }

    // Enter — drill into detail view
    if (key.return) {
      if (data === null) return;
      const panel = nav.focusedPanel;
      const filter = nav.filters[panel];
      const allItems = getPanelItems(panel, data);
      const filteredItems = filter !== null ? allItems.filter((item) => item.status === filter) : allItems;
      const selectedItem = filteredItems[nav.selectedIndices[panel]];
      if (selectedItem === undefined) return;
      // Cast id back to the branded type for the discriminated ViewState union.
      // The id originates from the domain entity — the cast is safe at this boundary.
      switch (panel) {
        case 'loops':
          setView({ kind: 'detail', entityType: 'loops', entityId: selectedItem.id as LoopId });
          break;
        case 'tasks':
          setView({ kind: 'detail', entityType: 'tasks', entityId: selectedItem.id as TaskId });
          break;
        case 'schedules':
          setView({ kind: 'detail', entityType: 'schedules', entityId: selectedItem.id as ScheduleId });
          break;
        case 'orchestrations':
          setView({ kind: 'detail', entityType: 'orchestrations', entityId: selectedItem.id as OrchestratorId });
          break;
      }
      return;
    }

    // f — cycle filter for focused panel
    if (input === 'f') {
      setNav((prev) => {
        const panel = prev.focusedPanel;
        const currentFilter = prev.filters[panel];
        const currentIdx = FILTER_CYCLE.indexOf(currentFilter);
        const nextIdx = (currentIdx + 1) % FILTER_CYCLE.length;
        const nextFilter = FILTER_CYCLE[nextIdx] ?? null;

        // Clamp selectedIndex to new filtered length (use ref for freshness)
        const newLength = filteredLength(panel, dataRef.current, nextFilter);
        const clampedIndex = clamp(prev.selectedIndices[panel], 0, Math.max(0, newLength - 1));

        return {
          ...prev,
          filters: { ...prev.filters, [panel]: nextFilter },
          selectedIndices: { ...prev.selectedIndices, [panel]: clampedIndex },
          scrollOffsets: { ...prev.scrollOffsets, [panel]: 0 },
        };
      });
      return;
    }
  });
}

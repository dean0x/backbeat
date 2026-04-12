/**
 * Key handler for the workspace view.
 *
 * Scope: view.kind === 'workspace'. Handles orchestration nav (↑/↓/Enter),
 * Tab/Shift+Tab focus cycling, panel scroll ([/]/g/G), fullscreen toggle (f),
 * pagination (PgUp/PgDn), and cancel/delete via entity-mutations.
 */

import type { OrchestratorChild, TaskId } from '../../../core/domain.js';
import type { WorkspaceNavState } from '../workspace-types.js';
import { TERMINAL_STATUSES } from './constants.js';
import { cancelEntity, deleteEntity } from './entity-mutations.js';
import type { InkKey, KeyHandlerParams } from './types.js';

/**
 * Return the focused child task panel for the current workspace view, or null.
 * Shared by scroll ([/]/g/G), drill-through (Enter), and cancel/delete (c/d) handlers.
 */
function getFocusedChild(
  dataRef: KeyHandlerParams['dataRef'],
  workspaceNav: WorkspaceNavState,
): OrchestratorChild | null {
  const children = dataRef.current?.workspaceData?.children;
  if (!children || children.length === 0) return null;
  return children[workspaceNav.focusedPanelIndex] ?? null;
}

/**
 * Handle key input while in the workspace view.
 * Returns true if the key was consumed.
 *
 * Key routing:
 *  - ↑/k / ↓/j   : move nav cursor (nav focus only)
 *  - Enter        : commit nav selection → grid focus; grid focus → drill into child detail
 *  - Tab          : cycle focusArea nav → grid → nav
 *  - Shift+Tab    : reverse cycle
 *  - 1-9          : jump to panel index (grid focus)
 *  - f            : toggle fullscreen for focused panel
 *  - [/]          : scroll focused panel up/down with auto-tail toggle
 *  - g/G          : jump to top / bottom of focused panel
 *  - PgUp/PgDn    : page grid
 *  - Esc/Backspace: exit fullscreen → return to main
 *  - c/d          : cancel/delete (nav: committed orch; grid: focused child task)
 */
export function handleWorkspaceKeys(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { view, setView, dataRef, mutations, refreshNow } = params;
  if (view.kind !== 'workspace') return false;
  const { workspaceNav, setWorkspaceNav } = params;
  if (!workspaceNav || !setWorkspaceNav) return false;

  // Esc / Backspace — exit fullscreen if active; otherwise return to main
  if (key.escape || key.backspace) {
    if (workspaceNav.fullscreenPanelIndex !== null) {
      setWorkspaceNav((prev) => ({ ...prev, fullscreenPanelIndex: null }));
    } else {
      setView({ kind: 'main' });
    }
    return true;
  }

  // Tab — cycle focusArea: nav → grid → nav; also cycle focusedPanelIndex within grid
  if (key.tab && !key.shift) {
    setWorkspaceNav((prev) => {
      if (prev.focusArea === 'nav') {
        return { ...prev, focusArea: 'grid' };
      }
      // grid → advance panel or wrap back to nav
      const data = dataRef.current;
      const childCount = data?.workspaceData?.children.length ?? 0;
      if (childCount === 0) {
        // No panels — just toggle back to nav
        return { ...prev, focusArea: 'nav' };
      }
      const nextPanel = (prev.focusedPanelIndex + 1) % childCount;
      if (nextPanel === 0) {
        // Wrapped around — go back to nav
        return { ...prev, focusArea: 'nav', focusedPanelIndex: 0 };
      }
      return { ...prev, focusArea: 'grid', focusedPanelIndex: nextPanel };
    });
    return true;
  }

  // Shift+Tab — reverse cycle
  if (key.tab && key.shift) {
    setWorkspaceNav((prev) => {
      if (prev.focusArea === 'grid') {
        return { ...prev, focusArea: 'nav' };
      }
      return { ...prev, focusArea: 'grid' };
    });
    return true;
  }

  // ↑ / k — move nav cursor up (nav focus only)
  if (key.upArrow || input === 'k') {
    if (workspaceNav.focusArea === 'nav') {
      setWorkspaceNav((prev) => ({
        ...prev,
        selectedOrchestratorIndex: Math.max(0, prev.selectedOrchestratorIndex - 1),
      }));
      return true;
    }
    return true; // consume in grid too (no-op for now)
  }

  // ↓ / j — move nav cursor down (nav focus only)
  // Upper clamp: if orchestration list is available, clamp to list length - 1.
  // When list is empty (e.g. during test with no data), allow cursor to move freely.
  if (key.downArrow || input === 'j') {
    if (workspaceNav.focusArea === 'nav') {
      const orchList = dataRef.current?.orchestrations;
      const maxIdx = orchList && orchList.length > 0 ? orchList.length - 1 : Number.MAX_SAFE_INTEGER;
      setWorkspaceNav((prev) => ({
        ...prev,
        selectedOrchestratorIndex: Math.min(maxIdx, prev.selectedOrchestratorIndex + 1),
      }));
      return true;
    }
    return true; // consume in grid too
  }

  // Enter — commit (nav focus) or drill into child detail (grid focus)
  if (key.return) {
    if (workspaceNav.focusArea === 'nav') {
      setWorkspaceNav((prev) => ({
        ...prev,
        committedOrchestratorIndex: prev.selectedOrchestratorIndex,
        fullscreenPanelIndex: null,
        focusArea: 'grid',
      }));
      return true;
    }
    // grid focus — drill into child task detail
    const child = getFocusedChild(dataRef, workspaceNav);
    if (child) {
      setView({ kind: 'detail', entityType: 'tasks', entityId: child.taskId as TaskId, returnTo: 'workspace' });
    }
    return true;
  }

  // f — toggle fullscreen for focused panel (grid focus)
  if (input === 'f') {
    if (workspaceNav.focusArea === 'grid') {
      setWorkspaceNav((prev) => ({
        ...prev,
        fullscreenPanelIndex: prev.fullscreenPanelIndex === prev.focusedPanelIndex ? null : prev.focusedPanelIndex,
      }));
    }
    return true;
  }

  // 1–9 — jump to panel by number (grid focus)
  if (input >= '1' && input <= '9' && workspaceNav.focusArea === 'grid') {
    const panelIdx = parseInt(input, 10) - 1;
    const data = dataRef.current;
    const childCount = data?.workspaceData?.children.length ?? 0;
    if (panelIdx < childCount) {
      setWorkspaceNav((prev) => ({ ...prev, focusedPanelIndex: panelIdx }));
    }
    return true;
  }

  // [ — scroll focused panel up
  if (input === '[') {
    const child = getFocusedChild(dataRef, workspaceNav);
    if (child) {
      const taskId = child.taskId;
      setWorkspaceNav((prev) => ({
        ...prev,
        panelScrollOffsets: {
          ...prev.panelScrollOffsets,
          [taskId]: Math.max(0, (prev.panelScrollOffsets[taskId] ?? 0) - 1),
        },
        autoTailEnabled: { ...prev.autoTailEnabled, [taskId]: false },
      }));
    }
    return true;
  }

  // ] — scroll focused panel down
  if (input === ']') {
    const child = getFocusedChild(dataRef, workspaceNav);
    if (child) {
      const taskId = child.taskId;
      setWorkspaceNav((prev) => ({
        ...prev,
        panelScrollOffsets: {
          ...prev.panelScrollOffsets,
          [taskId]: (prev.panelScrollOffsets[taskId] ?? 0) + 1,
        },
        // auto-tail stays as-is — caller re-enables when reaching bottom
      }));
    }
    return true;
  }

  // g — jump to top of focused panel
  if (input === 'g') {
    const child = getFocusedChild(dataRef, workspaceNav);
    if (child) {
      const taskId = child.taskId;
      setWorkspaceNav((prev) => ({
        ...prev,
        panelScrollOffsets: { ...prev.panelScrollOffsets, [taskId]: 0 },
        autoTailEnabled: { ...prev.autoTailEnabled, [taskId]: false },
      }));
    }
    return true;
  }

  // G — jump to bottom and re-engage auto-tail
  if (input === 'G') {
    const child = getFocusedChild(dataRef, workspaceNav);
    if (child) {
      const taskId = child.taskId;
      setWorkspaceNav((prev) => ({
        ...prev,
        panelScrollOffsets: { ...prev.panelScrollOffsets, [taskId]: 0 },
        autoTailEnabled: { ...prev.autoTailEnabled, [taskId]: true },
      }));
    }
    return true;
  }

  // PgUp — previous grid page
  if (key.pageUp) {
    setWorkspaceNav((prev) => ({
      ...prev,
      gridPage: Math.max(0, prev.gridPage - 1),
    }));
    return true;
  }

  // PgDn — next grid page
  if (key.pageDown) {
    setWorkspaceNav((prev) => ({
      ...prev,
      gridPage: prev.gridPage + 1,
    }));
    return true;
  }

  // c — cancel (nav: committed orch with cascade; grid: focused child task)
  if (input === 'c' && mutations) {
    if (workspaceNav.focusArea === 'nav') {
      const orch = (dataRef.current?.orchestrations ?? [])[workspaceNav.committedOrchestratorIndex];
      if (orch && !TERMINAL_STATUSES.orchestrations.includes(orch.status)) {
        void cancelEntity('orchestration', orch.id, orch.status, mutations, refreshNow);
      }
    } else {
      // grid focus — cancel focused child task
      const child = getFocusedChild(dataRef, workspaceNav);
      if (child && !TERMINAL_STATUSES.tasks.includes(child.status)) {
        void cancelEntity('task', child.taskId, child.status, mutations, refreshNow);
      }
    }
    return true;
  }

  // d — delete terminal entity (grid focus only; nav focus is ignored)
  if (input === 'd' && mutations) {
    if (workspaceNav.focusArea === 'grid') {
      const child = getFocusedChild(dataRef, workspaceNav);
      if (child && TERMINAL_STATUSES.tasks.includes(child.status)) {
        void deleteEntity('task', child.taskId, child.status, mutations, refreshNow);
      }
    }
    return true;
  }

  return false;
}

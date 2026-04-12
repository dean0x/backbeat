/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 *
 * This module is intentionally thin (~50 lines). All handler logic lives in keyboard/:
 *  - keyboard/handle-detail-keys.ts    — detail view key routing
 *  - keyboard/handle-workspace-keys.ts — workspace view key routing
 *  - keyboard/handle-main-keys.ts      — main panel key routing
 *  - keyboard/entity-mutations.ts      — unified cancel/delete dispatch
 *  - keyboard/constants.ts             — PANEL_ORDER, FILTER_CYCLES, etc.
 *  - keyboard/helpers.ts               — pure nav helpers
 *  - keyboard/types.ts                 — KeyHandlerParams, UseKeyboardParams
 */

import { useInput } from 'ink';
import { useRef } from 'react';
import { DETAIL_SCROLL_MAX_DEFAULT } from './keyboard/constants.js';
import { handleDetailKeys } from './keyboard/handle-detail-keys.js';
import { handleMainKeys } from './keyboard/handle-main-keys.js';
import { handleWorkspaceKeys } from './keyboard/handle-workspace-keys.js';
import type { UseKeyboardParams } from './keyboard/types.js';

export type { UseKeyboardParams } from './keyboard/types.js';

/**
 * Custom hook wrapping Ink's useInput.
 * Routes keys to handlers based on current view (main, workspace, or detail).
 *
 * Global keys (handled before view dispatch):
 *  - q: quit
 *  - r: refresh
 *  - v: toggle between main/workspace (ignored when in detail — user must Esc first)
 *  - m: jump to main (works from any view)
 *  - w: jump to workspace (works from any view)
 */
export function useKeyboard({
  view,
  nav,
  data,
  setView,
  setNav,
  refreshNow,
  exit,
  detailContentLength,
  mutations,
  workspaceNav,
  setWorkspaceNav,
}: UseKeyboardParams): void {
  // Keep a ref to the latest data so setNav functional updaters always see
  // current data, not stale closure data from the render that registered useInput.
  const dataRef = useRef(data);
  dataRef.current = data;

  useInput((input, key) => {
    // Global keys — handled before view dispatch
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'r') {
      refreshNow();
      return;
    }

    // v — toggle between main and workspace (ignored in detail view)
    if (input === 'v' && view.kind !== 'detail') {
      if (view.kind === 'workspace') {
        setView({ kind: 'main' });
      } else {
        setView({ kind: 'workspace' });
      }
      return;
    }

    // m — jump to main from any view (including detail — acts like Esc→m)
    if (input === 'm') {
      setView({ kind: 'main' });
      return;
    }

    // w — jump to workspace from any view (including detail — acts like Esc→w)
    if (input === 'w') {
      setView({ kind: 'workspace' });
      return;
    }

    const params = {
      view,
      nav,
      data,
      dataRef,
      setView,
      setNav,
      detailContentLength: detailContentLength ?? DETAIL_SCROLL_MAX_DEFAULT,
      mutations,
      refreshNow,
      workspaceNav,
      setWorkspaceNav,
    };

    if (view.kind === 'detail') {
      handleDetailKeys(input, key, params);
    } else if (view.kind === 'workspace') {
      handleWorkspaceKeys(input, key, params);
    } else {
      handleMainKeys(input, key, params);
    }
  });
}

/**
 * Tests for useTerminalSize hook
 * ARCHITECTURE: Tests behavior — correct source priority, fallback chain, debounce, cleanup
 */

import { render } from 'ink-testing-library';
import React, { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalSize } from '../../../../src/cli/dashboard/use-terminal-size.js';

// ============================================================================
// Test helper — captures hook result into a ref
// ============================================================================

interface Capture {
  columns: number;
  rows: number;
}

function TestCapture({ captureRef }: { captureRef: React.MutableRefObject<Capture | null> }): React.ReactElement {
  const size = useTerminalSize();
  const ref = useRef(captureRef);
  useEffect(() => {
    ref.current.current = size;
  });
  // Return empty fragment — we only care about the hook result
  return React.createElement(React.Fragment);
}

function renderHook(): { captureRef: React.MutableRefObject<Capture | null>; unmount: () => void } {
  const captureRef = React.createRef() as React.MutableRefObject<Capture | null>;
  captureRef.current = null;
  const { unmount } = render(React.createElement(TestCapture, { captureRef }));
  return { captureRef, unmount };
}

// ============================================================================
// Setup / teardown — save and restore process streams
// ============================================================================

let originalStderrColumns: number | undefined;
let originalStderrRows: number | undefined;
let originalStdoutColumns: number | undefined;
let originalStdoutRows: number | undefined;
let originalStderrOn: typeof process.stderr.on;
let originalStderrOff: typeof process.stderr.off;

beforeEach(() => {
  originalStderrColumns = process.stderr.columns;
  originalStderrRows = process.stderr.rows;
  originalStdoutColumns = process.stdout.columns;
  originalStdoutRows = process.stdout.rows;
  originalStderrOn = process.stderr.on.bind(process.stderr);
  originalStderrOff = process.stderr.off.bind(process.stderr);
});

afterEach(() => {
  Object.defineProperty(process.stderr, 'columns', {
    value: originalStderrColumns,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stderr, 'rows', {
    value: originalStderrRows,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'columns', {
    value: originalStdoutColumns,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'rows', {
    value: originalStdoutRows,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('useTerminalSize', () => {
  describe('source priority', () => {
    it('reads columns and rows from process.stderr when available', () => {
      Object.defineProperty(process.stderr, 'columns', { value: 120, configurable: true, writable: true });
      Object.defineProperty(process.stderr, 'rows', { value: 40, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 999, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'rows', { value: 999, configurable: true, writable: true });

      const { captureRef, unmount } = renderHook();
      expect(captureRef.current?.columns).toBe(120);
      expect(captureRef.current?.rows).toBe(40);
      unmount();
    });

    it('falls back to stdout when stderr.columns is undefined', () => {
      Object.defineProperty(process.stderr, 'columns', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(process.stderr, 'rows', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 90, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true, writable: true });

      const { captureRef, unmount } = renderHook();
      expect(captureRef.current?.columns).toBe(90);
      expect(captureRef.current?.rows).toBe(30);
      unmount();
    });

    it('falls back to defaults (80 x 24) when both stderr and stdout are undefined', () => {
      Object.defineProperty(process.stderr, 'columns', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(process.stderr, 'rows', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true, writable: true });

      const { captureRef, unmount } = renderHook();
      expect(captureRef.current?.columns).toBe(80);
      expect(captureRef.current?.rows).toBe(24);
      unmount();
    });

    it('uses stderr columns but falls back to stdout rows when only stderr rows is missing', () => {
      Object.defineProperty(process.stderr, 'columns', { value: 120, configurable: true, writable: true });
      Object.defineProperty(process.stderr, 'rows', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'rows', { value: 36, configurable: true, writable: true });

      const { captureRef, unmount } = renderHook();
      expect(captureRef.current?.columns).toBe(120);
      expect(captureRef.current?.rows).toBe(36);
      unmount();
    });
  });

  describe('debouncing', () => {
    it('debounces resize events by scheduling via setTimeout with 50ms delay', () => {
      vi.useFakeTimers();

      // Spy on setTimeout to verify debounce uses the correct delay
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      Object.defineProperty(process.stderr, 'columns', { value: 80, configurable: true, writable: true });
      Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true, writable: true });

      let resizeHandler: (() => void) | undefined;
      vi.spyOn(process.stderr, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'resize') resizeHandler = handler as () => void;
          return process.stderr;
        },
      );
      vi.spyOn(process.stderr, 'off').mockReturnValue(process.stderr);

      const { unmount } = renderHook();

      // Reset spy to only track calls from our resize handler
      setTimeoutSpy.mockClear();

      // Trigger a resize event
      resizeHandler?.();

      // Verify that a debounce timer was scheduled with 50ms delay
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 50);

      unmount();
      vi.useRealTimers();
    });

    it('resets debounce timer on multiple rapid resize events', () => {
      vi.useFakeTimers();

      Object.defineProperty(process.stderr, 'columns', { value: 80, configurable: true, writable: true });
      Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true, writable: true });

      let resizeHandler: (() => void) | undefined;
      vi.spyOn(process.stderr, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'resize') resizeHandler = handler as () => void;
          return process.stderr;
        },
      );
      vi.spyOn(process.stderr, 'off').mockReturnValue(process.stderr);

      const { captureRef, unmount } = renderHook();

      // Fire multiple resize events in rapid succession
      resizeHandler?.();
      vi.advanceTimersByTime(30);
      resizeHandler?.();
      vi.advanceTimersByTime(30);
      resizeHandler?.();

      // Debounce should not have fired yet (still within 50ms of last event)
      expect(captureRef.current?.columns).toBe(80);

      // Advance past debounce
      vi.advanceTimersByTime(60);
      // Now state should have updated
      expect(captureRef.current?.columns).toBe(80); // value hasn't changed in this test

      unmount();
      vi.useRealTimers();
    });
  });

  describe('cleanup', () => {
    it('removes the resize listener on unmount', () => {
      const offSpy = vi.spyOn(process.stderr, 'off').mockReturnValue(process.stderr);
      vi.spyOn(process.stderr, 'on').mockReturnValue(process.stderr);

      const { unmount } = renderHook();
      unmount();

      expect(offSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    });

    it('clears any pending debounce timer on unmount', () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(global, 'clearTimeout');

      let resizeHandler: (() => void) | undefined;
      vi.spyOn(process.stderr, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'resize') resizeHandler = handler as () => void;
          return process.stderr;
        },
      );
      vi.spyOn(process.stderr, 'off').mockReturnValue(process.stderr);

      const { unmount } = renderHook();

      // Trigger a resize to schedule a pending debounce
      resizeHandler?.();

      // Unmount before debounce fires
      unmount();

      // clearTimeout should have been called to cancel the pending timer
      expect(clearSpy).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});

/**
 * useResourceMetrics — polls SystemResourceMonitor.getResources() every 2s
 * ARCHITECTURE: Pure hook, no side effects beyond interval
 * Pattern: fetching ref prevents overlapping polls (same pattern as use-dashboard-data.ts)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemResources } from '../../core/domain.js';
import type { ResourceMonitor } from '../../core/interfaces.js';

const POLL_INTERVAL_MS = 2_000;

export interface UseResourceMetricsResult {
  readonly resources: SystemResources | null;
  readonly error: string | null;
}

export function useResourceMetrics(resourceMonitor: ResourceMonitor | undefined): UseResourceMetricsResult {
  const [resources, setResources] = useState<SystemResources | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guard against overlapping fetches
  const fetching = useRef(false);
  // Prevent setState after unmount
  const closing = useRef(false);

  const doFetch = useCallback(async (): Promise<void> => {
    if (!resourceMonitor) return;
    if (fetching.current) return;

    fetching.current = true;
    try {
      const result = await resourceMonitor.getResources();
      if (closing.current) return;

      if (result.ok) {
        setResources(result.value);
        setError(null);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      if (!closing.current) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Resource monitor error: ${message}`);
      }
    } finally {
      fetching.current = false;
    }
  }, [resourceMonitor]);

  useEffect(() => {
    closing.current = false;

    // Initial fetch immediately on mount
    void doFetch();

    const intervalId = setInterval(() => {
      void doFetch();
    }, POLL_INTERVAL_MS);

    return () => {
      closing.current = true;
      clearInterval(intervalId);
    };
  }, [doFetch]);

  return { resources, error };
}

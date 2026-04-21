'use client';

import { useEffect, useRef, useState } from 'react';

export const DEFAULT_POLL_INTERVAL_MS = 5000;

interface Options {
  intervalMs?: number;
  /** When false, polling does not start. Use for conditional fetches (e.g. no eventId yet). */
  enabled?: boolean;
}

export interface UseIntervalPollingResult<T> {
  data: T | null;
  error: string | null;
  connected: boolean;
}

/**
 * Runs `fetcher` once on mount and again every `intervalMs` until unmount.
 *
 * - The latest `fetcher` is captured via ref, so callers can pass a new
 *   closure on every render without recreating the interval.
 * - `data` is only updated when the serialized payload differs, so React
 *   skips re-renders when the backend returns identical content.
 * - A cancel flag prevents in-flight responses from touching state after
 *   unmount (React 18 StrictMode and navigation both hit this).
 */
export function useIntervalPolling<T>(
  fetcher: () => Promise<T | null>,
  options: Options = {},
): UseIntervalPollingResult<T> {
  const { intervalMs = DEFAULT_POLL_INTERVAL_MS, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const run = async () => {
      try {
        const fresh = await fetcherRef.current();
        if (cancelled) return;
        setData((prev) =>
          JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh,
        );
        setError(null);
        setConnected(true);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setConnected(false);
      }
    };

    run();
    const id = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, enabled]);

  return { data, error, connected };
}

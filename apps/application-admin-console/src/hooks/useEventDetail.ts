import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api/client";
import { type EventDetail, getEvent } from "../api/events-client";
import { toErrorMessage } from "../lib/error-message";

export function useEventDetail(args: {
  readonly apiClient: ApiClient | null;
  readonly eventId: string | undefined;
  readonly eventIdValid: boolean;
}) {
  const { apiClient, eventId, eventIdValid } = args;
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshInFlight, setManualRefreshInFlight] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiClient || !eventIdValid || !eventId) return;
    try {
      // Issue #1038 P1 #7: operator が「どのチームがいつ加点 / 減点したか」 を一目で
      // 把握できるよう、 Event 詳細取得で全 team の score event timeline も同時に fetch する。
      const nextDetail = await getEvent(apiClient, eventId, { withScoreEvents: true });
      setDetail(nextDetail);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [apiClient, eventId, eventIdValid]);

  const manualRefresh = useCallback(async () => {
    if (manualRefreshInFlight) return;
    setManualRefreshInFlight(true);
    try {
      await refresh();
    } finally {
      setManualRefreshInFlight(false);
    }
  }, [manualRefreshInFlight, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    detail,
    error,
    manualRefresh,
    manualRefreshInFlight,
    refresh,
    setError,
  };
}

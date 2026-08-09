import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api/client";
import { type EventDetail, getEvent } from "../api/events-client";

/** 30s: fast enough to follow a live scoreboard, slow enough not to hammer the API. */
const EVENT_DETAIL_POLL_INTERVAL_MS = 30_000;

/**
 * Is the event running right now? Drives whether auto-refresh polls at all.
 *
 * Both bounds are optional (#536: the backend returns only requested fields). A missing
 * bound is treated as open on that side — an event with no declared end has not ended —
 * so an incompletely-specified event still refreshes rather than silently going stale.
 */
function isRunningNow(detail: EventDetail | null, now: number = Date.now()): boolean {
  if (!detail) return false;
  const startsAt = detail.startsAt === undefined ? Number.NaN : Date.parse(detail.startsAt);
  const endsAt = detail.endsAt === undefined ? Number.NaN : Date.parse(detail.endsAt);
  if (Number.isFinite(startsAt) && now < startsAt) return false;
  if (Number.isFinite(endsAt) && now >= endsAt) return false;
  return true;
}

export function useEventDetail(args: {
  readonly apiClient: ApiClient | null;
  readonly eventId: string | undefined;
  readonly eventIdValid: boolean;
  readonly withTeamLoginKeys?: boolean;
}) {
  const { apiClient, eventId, eventIdValid, withTeamLoginKeys = false } = args;
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshInFlight, setManualRefreshInFlight] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiClient || !eventIdValid || !eventId) return;
    try {
      // Issue #1038 P1 #7: operator が「どのチームがいつ加点 / 減点したか」 を一目で
      // 把握できるよう、 Event 詳細取得で全 team の score event timeline も同時に fetch する。
      const nextDetail = await getEvent(apiClient, eventId, {
        withScoreEvents: true,
        ...(withTeamLoginKeys ? { withTeamLoginKeys: true } : {}),
      });
      setDetail(nextDetail);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [apiClient, eventId, eventIdValid, withTeamLoginKeys]);

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

  // Live events are watched with this screen left open, so a fetch-once-on-mount hook
  // means the operator reads a frozen snapshot: a participant submits, scores move, and
  // the console keeps showing 0 pt and "no score history yet" until someone presses
  // refresh. That is the exact situation this screen exists for.
  //
  // Polling is on while the event is running and off otherwise, so a finished or
  // not-yet-started event costs nothing. `immediate: false` because the mount effect above
  // already did the first fetch; polling starts from the next tick. Reuses web-kit's
  // usePolling (#1418) rather than adding another interval implementation.
  //
  // No on/off toggle yet: the participant portal has one, but wiring it here means
  // threading state through EventDetailLoaded → tabs → OverviewTab → DeployProgressPanel,
  // and the issue asks for "auto-refresh on by default while the event is running" as the
  // minimum. The manual refresh button stays exactly as it was.
  usePolling(refresh, EVENT_DETAIL_POLL_INTERVAL_MS, {
    immediate: false,
    enabled: isRunningNow(detail) && Boolean(apiClient) && eventIdValid,
  });

  return {
    detail,
    error,
    manualRefresh,
    manualRefreshInFlight,
    refresh,
    setError,
  };
}

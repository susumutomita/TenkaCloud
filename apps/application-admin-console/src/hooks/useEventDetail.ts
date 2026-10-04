import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import { type EventDetail, getEvent } from "../api/events-client";

/** 30s: fast enough to follow a live scoreboard, slow enough not to hammer the API. */
const EVENT_DETAIL_POLL_INTERVAL_MS = 30_000;
const IN_FLIGHT_DEPLOYMENT_STATUSES = new Set(["PENDING", "IN_PROGRESS", "DELETING"]);

/** Is any environment of this event still being created, changed or removed? */
function hasEnvironmentWorkInFlight(detail: EventDetail | null): boolean {
  return Object.values(detail?.deploymentsByProblem ?? {}).some((deployments) =>
    deployments.some(
      (deployment) =>
        deployment.operation !== undefined || IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status),
    ),
  );
}

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
  /**
   * Issue #3226: the local competition host finishes deploys and environment operations in
   * seconds, so its console follows them at this interval while any is in flight. Unset (the
   * cloud console) uses 30s polling while environment work or a live event is active.
   */
  readonly inFlightPollMs?: number;
}) {
  const { apiClient, eventId, eventIdValid, withTeamLoginKeys = false, inFlightPollMs } = args;
  const requestSequence = useRef(0);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshInFlight, setManualRefreshInFlight] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiClient || !eventIdValid || !eventId) return;
    const sequence = ++requestSequence.current;
    try {
      // Issue #1038 P1 #7: operator が「どのチームがいつ加点 / 減点したか」 を一目で
      // 把握できるよう、 Event 詳細取得で全 team の score event timeline も同時に fetch する。
      const nextDetail = await getEvent(apiClient, eventId, {
        withScoreEvents: true,
        ...(withTeamLoginKeys ? { withTeamLoginKeys: true } : {}),
      });
      if (sequence !== requestSequence.current) return;
      setDetail(nextDetail);
      setError(null);
    } catch (err) {
      if (sequence !== requestSequence.current) return;
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

  // Follow preparation and teardown even outside the competition's scoring window.
  // One timer avoids duplicate live-event and environment-work requests.
  const environmentWorkInFlight = hasEnvironmentWorkInFlight(detail);
  usePolling(
    refresh,
    environmentWorkInFlight
      ? (inFlightPollMs ?? EVENT_DETAIL_POLL_INTERVAL_MS)
      : EVENT_DETAIL_POLL_INTERVAL_MS,
    {
      immediate: false,
      enabled:
        (isRunningNow(detail) || environmentWorkInFlight) && Boolean(apiClient) && eventIdValid,
    },
  );

  return {
    detail,
    error,
    manualRefresh,
    manualRefreshInFlight,
    refresh,
    setError,
  };
}

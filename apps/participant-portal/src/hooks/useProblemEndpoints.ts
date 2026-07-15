import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import { listProblemEndpoints, type ParticipantEndpointView } from "../api/portal-client";

export interface ProblemEndpointsState {
  readonly endpoints: readonly ParticipantEndpointView[] | undefined;
  readonly error: string | undefined;
  readonly replaceEndpoints: (endpoints: readonly ParticipantEndpointView[]) => void;
}

interface ProblemEndpointsSnapshot {
  readonly requestKey: string;
  readonly endpoints?: readonly ParticipantEndpointView[];
  readonly error?: string;
}

/** Owns the one authoritative endpoint-registry view shared by the form and plugins. */
export function useProblemEndpoints({
  apiBaseUrl,
  teamLoginKey,
  problemId,
  enabled,
}: {
  readonly apiBaseUrl: string;
  readonly teamLoginKey: string;
  readonly problemId: string;
  readonly enabled: boolean;
}): ProblemEndpointsState {
  const requestKey = JSON.stringify([apiBaseUrl, teamLoginKey, problemId]);
  const [snapshot, setSnapshot] = useState<ProblemEndpointsSnapshot>();

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    void listProblemEndpoints(apiBaseUrl, teamLoginKey, problemId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setSnapshot({ requestKey, endpoints: response.endpoints });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setSnapshot({ requestKey, error: toErrorMessage(cause) });
      });

    return () => controller.abort();
  }, [apiBaseUrl, teamLoginKey, problemId, enabled, requestKey]);

  const replaceEndpoints = useCallback(
    (next: readonly ParticipantEndpointView[]) => {
      setSnapshot({ requestKey, endpoints: next });
    },
    [requestKey],
  );

  const currentSnapshot = enabled && snapshot?.requestKey === requestKey ? snapshot : undefined;

  return {
    endpoints: currentSnapshot?.endpoints,
    error: currentSnapshot?.error,
    replaceEndpoints,
  };
}

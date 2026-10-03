import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { usePolling } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeHostContainer,
  type ParticipantProblemView,
  PortalValidationError,
} from "../api/portal-client";
import { LOCAL_LIFECYCLE_POLL_INTERVAL_MS } from "../constants/polling";
import { useLang, useT } from "../i18n";
import { hostContainerMessages } from "../i18n/host-container-locales";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";

type Session = NonNullable<ParticipantProblemView["containerSession"]>;
type Action = "start" | "stop";
function indicatorType(status: Session["status"]): StatusIndicatorProps.Type {
  if (status === "starting" || status === "stopping") return "loading";
  if (status === "error") return "error";
  return status === "running" ? "success" : "stopped";
}

export function HostContainerControls({
  session,
  problemId,
  apiBaseUrl,
  sessionToken,
  onScored,
}: {
  readonly session?: Session;
  readonly problemId: string;
  readonly apiBaseUrl: string;
  readonly sessionToken: string;
  readonly onScored: () => Promise<void>;
}) {
  const copy = hostContainerMessages[useLang()];
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const actionActive = useRef(false);
  const refreshing = useRef(false);
  const status = session?.status;
  const transition = status === "starting" || status === "stopping";

  const describeError = useCallback(
    (cause: unknown) => {
      if (cause instanceof PortalValidationError) {
        switch (cause.errorCode) {
          case "team_container_limit":
            return copy.team_container_limit;
          case "host_container_limit":
            return copy.host_container_limit;
          case "host_container_memory_limit":
            return copy.host_container_memory_limit;
          case "container_busy":
            return copy.container_busy;
        }
      }
      return formatProblemPanelActionError(t, cause, "problem_panel.validation_error");
    },
    [copy, t],
  );

  const refresh = useCallback(
    async (isActive: () => boolean = () => true) => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        await onScored();
      } catch (cause) {
        if (isActive()) setError(describeError(cause));
      } finally {
        refreshing.current = false;
      }
    },
    [onScored, describeError],
  );

  useEffect(() => {
    if (
      status === undefined ||
      status === "error" ||
      (pending === "start" && status === "running") ||
      (pending === "stop" && status === "stopped")
    )
      setPending(null);
  }, [status, pending]);
  usePolling(refresh, LOCAL_LIFECYCLE_POLL_INTERVAL_MS, {
    enabled: transition || pending !== null,
    immediate: false,
  });

  const run = async (action: Action) => {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true);
    setError(null);
    setPending(action);
    try {
      await changeHostContainer(apiBaseUrl, sessionToken, problemId, action);
    } catch (cause) {
      setPending(null);
      setError(describeError(cause));
    } finally {
      await refresh();
      actionActive.current = false;
      setBusy(false);
    }
  };
  if (!session) return null;
  const running = session.status === "running";
  const disabled = busy || transition || pending !== null;
  return (
    <Container header={<Header variant="h3">{copy.title}</Header>}>
      <SpaceBetween size="s">
        <StatusIndicator type={indicatorType(session.status)}>
          {copy.status[session.status]}
        </StatusIndicator>
        <Box>{copy.retained}</Box>
        {(error || session.error) && (
          <Alert type="error" header={copy.failed}>
            {error ?? session.error}
          </Alert>
        )}
        <Button
          disabled={disabled}
          loading={busy}
          onClick={() => {
            void run(running ? "stop" : "start");
          }}
        >
          {running ? copy.stop : copy.start}
        </Button>
      </SpaceBetween>
    </Container>
  );
}

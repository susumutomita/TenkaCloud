import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { usePolling } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import type { ProblemLifecycleStatus, ProblemRuntimeKind } from "../api/portal-client";
import {
  issueProblemConsoleHandoff,
  resetProblem,
  startProblem,
  stopProblem,
} from "../api/portal-client";
import { LOCAL_LIFECYCLE_POLL_INTERVAL_MS } from "../constants/polling";
import { useT } from "../i18n";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";

type LifecycleAction = typeof startProblem;

const DOCKER_COPY = {
  actionFailedHeader: "problem_panel.lifecycle_action_failed_header",
  errorBody: "problem_panel.lifecycle_error_body",
  errorHeader: "problem_panel.lifecycle_error_header",
  runningBody: "problem_panel.lifecycle_running_body",
  stoppedBody: "problem_panel.lifecycle_stopped_body",
} as const;

const SIMULATOR_COPY = {
  actionFailedHeader: "problem_panel.lifecycle_simulator_action_failed_header",
  errorBody: "problem_panel.lifecycle_simulator_error_body",
  errorHeader: "problem_panel.lifecycle_simulator_error_header",
  runningBody: "problem_panel.lifecycle_simulator_running_body",
  stoppedBody: "problem_panel.lifecycle_simulator_stopped_body",
} as const;

/**
 * [#2392 Phase 2] local-play on-demand container control。 lifecycle field を持つ問題
 * (= local mode) にだけ描画され、 stopped / error では play surface の代わりに Start を、
 * running では play surface の脇に Stop を出す。 start / stop 成功後は `onScored` (= 親の
 * refetch) を await して poll が新しい lifecycle.status を拾う。 失敗は隠さず Alert で出す。
 */
export function ProblemLifecyclePanel({
  status,
  runtimeKind,
  cleanupRequired,
  lastError,
  apiBaseUrl,
  sessionToken,
  problemId,
  onScored,
}: {
  status: ProblemLifecycleStatus;
  runtimeKind: ProblemRuntimeKind | undefined;
  cleanupRequired: boolean;
  /** [#2392] 非同期 start の失敗理由 (lifecycle.lastError)。 error 状態でのみ表示。 */
  lastError?: string | undefined;
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  onScored: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [startAccepted, setStartAccepted] = useState(false);
  const simulatedCloud = runtimeKind === "simulated-cloud";
  const copy = simulatedCloud ? SIMULATOR_COPY : DOCKER_COPY;

  /**
   * [#2845] container の start は 202 で返り、 `starting` への遷移は refetch 経由でしか届かない。
   * その 1 回を取りこぼすと (server が evict 待ちでまだ stopped を返す / refetch が失敗する)
   * polling の enable 条件も満たされず、 永久に stopped 表示のまま固まる。 start を受理した
   * 事実を local state に残し、 server が stopped 以外を報告するまで starting を表示する。
   */
  const effectiveStatus: ProblemLifecycleStatus =
    startAccepted && status === "stopped" ? "starting" : status;

  useEffect(() => {
    if (status !== "stopped") setStartAccepted(false);
  }, [status]);

  const refreshStartingRuntime = useCallback(async () => {
    await onScored();
  }, [onScored]);

  usePolling(refreshStartingRuntime, LOCAL_LIFECYCLE_POLL_INTERVAL_MS, {
    enabled: effectiveStatus === "starting",
    immediate: false,
  });

  const runAction = async (action: LifecycleAction, startsRuntime = false) => {
    setBusy(true);
    setActionError(null);
    try {
      await action(apiBaseUrl, sessionToken, problemId);
      if (startsRuntime) setStartAccepted(true);
      await onScored();
    } catch (err) {
      setActionError(formatProblemPanelActionError(t, err, "problem_panel.validation_error"));
    } finally {
      setBusy(false);
    }
  };

  const openSimulatorConsole = async () => {
    const consoleWindow = window.open("about:blank", "_blank");
    if (consoleWindow) consoleWindow.opener = null;
    setBusy(true);
    setActionError(null);
    try {
      if (!consoleWindow) throw new Error("Simulator console popup was blocked");
      const handoffUrl = await issueProblemConsoleHandoff(apiBaseUrl, sessionToken, problemId);
      consoleWindow.location.replace(handoffUrl);
    } catch (err) {
      consoleWindow?.close();
      setActionError(formatProblemPanelActionError(t, err, "problem_panel.validation_error"));
    } finally {
      setBusy(false);
    }
  };

  const control =
    effectiveStatus === "starting" ? (
      <StatusIndicator type="loading">{t("problem_panel.lifecycle_starting")}</StatusIndicator>
    ) : effectiveStatus === "running" ? (
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Button loading={busy} onClick={() => void runAction(stopProblem)}>
          {t("problem_panel.lifecycle_stop_button")}
        </Button>
        {simulatedCloud && (
          <Button loading={busy} onClick={() => void runAction(resetProblem)}>
            {t("problem_panel.lifecycle_reset_button")}
          </Button>
        )}
        {simulatedCloud && (
          <Button iconName="external" loading={busy} onClick={() => void openSimulatorConsole()}>
            {t("problem_panel.lifecycle_simulator_console_button")}
          </Button>
        )}
        <Box variant="small" color="text-status-inactive">
          {t(copy.runningBody)}
        </Box>
      </SpaceBetween>
    ) : effectiveStatus === "error" && cleanupRequired ? (
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Button loading={busy} onClick={() => void runAction(stopProblem)}>
          {t("problem_panel.lifecycle_cleanup_button")}
        </Button>
        <Box variant="small" color="text-status-inactive">
          {t("problem_panel.lifecycle_cleanup_required_body")}
        </Box>
      </SpaceBetween>
    ) : (
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Button variant="primary" loading={busy} onClick={() => void runAction(startProblem, true)}>
          {t("problem_panel.lifecycle_start_button")}
        </Button>
        <Box variant="small" color="text-status-inactive">
          {t(copy.stoppedBody)}
        </Box>
      </SpaceBetween>
    );

  return (
    <SpaceBetween size="s">
      {status === "error" && (
        <Alert type="error" header={t(copy.errorHeader)}>
          <SpaceBetween size="xs">
            <Box>{t(copy.errorBody)}</Box>
            {lastError && <Box variant="code">{lastError}</Box>}
          </SpaceBetween>
        </Alert>
      )}
      {actionError !== null && (
        <Alert type="error" header={t(copy.actionFailedHeader)}>
          {actionError}
        </Alert>
      )}
      {control}
    </SpaceBetween>
  );
}

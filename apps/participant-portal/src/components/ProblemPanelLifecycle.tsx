import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useState } from "react";
import type { ProblemLifecycleStatus } from "../api/portal-client";
import { startProblem, stopProblem } from "../api/portal-client";
import { useT } from "../i18n";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";

/**
 * [#2392 Phase 2] local-play on-demand container control。 lifecycle field を持つ問題
 * (= local mode) にだけ描画され、 stopped / error では play surface の代わりに Start を、
 * running では play surface の脇に Stop を出す。 start / stop 成功後は `onScored` (= 親の
 * refetch) を await して poll が新しい lifecycle.status を拾う。 失敗は隠さず Alert で出す。
 */
export function ProblemLifecyclePanel({
  status,
  apiBaseUrl,
  sessionToken,
  problemId,
  onScored,
}: {
  status: ProblemLifecycleStatus;
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  onScored: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (action: typeof startProblem) => {
    setBusy(true);
    setActionError(null);
    try {
      await action(apiBaseUrl, sessionToken, problemId);
      await onScored();
    } catch (err) {
      setActionError(formatProblemPanelActionError(t, err, "problem_panel.validation_error"));
    } finally {
      setBusy(false);
    }
  };

  const control =
    status === "starting" ? (
      <StatusIndicator type="loading">{t("problem_panel.lifecycle_starting")}</StatusIndicator>
    ) : status === "running" ? (
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Button loading={busy} onClick={() => void runAction(stopProblem)}>
          {t("problem_panel.lifecycle_stop_button")}
        </Button>
        <Box variant="small" color="text-status-inactive">
          {t("problem_panel.lifecycle_running_body")}
        </Box>
      </SpaceBetween>
    ) : (
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Button variant="primary" loading={busy} onClick={() => void runAction(startProblem)}>
          {t("problem_panel.lifecycle_start_button")}
        </Button>
        <Box variant="small" color="text-status-inactive">
          {t("problem_panel.lifecycle_stopped_body")}
        </Box>
      </SpaceBetween>
    );

  return (
    <SpaceBetween size="s">
      {status === "error" && (
        <Alert type="error" header={t("problem_panel.lifecycle_error_header")}>
          {t("problem_panel.lifecycle_error_body")}
        </Alert>
      )}
      {actionError !== null && (
        <Alert type="error" header={t("problem_panel.lifecycle_action_failed_header")}>
          {actionError}
        </Alert>
      )}
      {control}
    </SpaceBetween>
  );
}

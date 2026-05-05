import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DeploymentStatus,
  getPortalMe,
  type ParticipantView,
  PortalAuthError,
  TERMINAL_STATUSES,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

const POLL_INTERVAL_MS = 5_000;

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

export function HomePage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const teamName = auth.session?.teamName ?? "(unknown)";
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";

  const [view, setView] = useState<ParticipantView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopPollingRef = useRef(false);

  const tick = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
    try {
      const next = await getPortalMe(config.apiBaseUrl, sessionToken);
      setView(next);
      setError(null);
      if (TERMINAL_STATUSES.has(next.status)) stopPollingRef.current = true;
    } catch (err) {
      if (err instanceof PortalAuthError) {
        // セッションが backend で無効化された (削除等)。logout して login へ戻す。
        auth.logout();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [isBackend, sessionToken, config.apiBaseUrl, auth]);

  useEffect(() => {
    if (!isBackend || !sessionToken) return;
    let cancelled = false;
    stopPollingRef.current = false;
    const run = async () => {
      if (cancelled || stopPollingRef.current) return;
      await tick();
    };
    void run();
    const interval = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isBackend, sessionToken, tick]);

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`${config.eventTitle} へようこそ`}>
        Welcome, {teamName}
      </Header>

      <Container header={<Header variant="h2">問題のデプロイ状況</Header>}>
        <SpaceBetween size="m">
          {!isBackend && (
            <Alert type="info">
              dev-mock モードで動作中です。実 backend と接続するには runtime-config の{" "}
              <code>mode</code> を <code>backend</code> に設定してください。
            </Alert>
          )}
          {error && (
            <Alert type="error" header="状態の取得に失敗しました">
              {error}
            </Alert>
          )}
          {isBackend && !view && !error && <Box>状態を取得中...</Box>}
          {view && (
            <>
              <StatusIndicator type={STATUS_TYPE[view.status]}>{view.status}</StatusIndicator>
              {view.status === "FAILED" && view.failureReason && (
                <Alert type="error" header="失敗理由">
                  {view.failureReason}
                </Alert>
              )}
              <ColumnLayout columns={2} variant="text-grid">
                <KeyValuePairs
                  items={[
                    { label: "Problem", value: <code>{view.problemId}</code> },
                    { label: "Region", value: view.region },
                  ]}
                />
                <KeyValuePairs
                  items={[
                    { label: "Job ID", value: <code>{view.jobId}</code> },
                    { label: "Team", value: view.teamName },
                  ]}
                />
              </ColumnLayout>
              {Object.keys(view.stackOutputs).length > 0 && (
                <Container header={<Header variant="h3">アクセス先 URL</Header>}>
                  <KeyValuePairs
                    items={Object.entries(view.stackOutputs).map(([label, value]) => ({
                      label,
                      value: (
                        <a href={value} target="_blank" rel="noreferrer noopener">
                          <code>{value}</code>
                        </a>
                      ),
                    }))}
                  />
                </Container>
              )}
              {!TERMINAL_STATUSES.has(view.status) && (
                <Box variant="small" color="text-status-info">
                  {POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。
                </Box>
              )}
            </>
          )}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">これからやること</Header>}>
        <Box variant="p">
          上のステータスが <strong>COMPLETE</strong> になると、CloudFormation Outputs に 表示される
          URL から問題に取り組めます。スコア状況は <strong>Scoreboard</strong>
          、得点履歴は <strong>Score events</strong> から確認してください。
        </Box>
      </Container>
    </SpaceBetween>
  );
}

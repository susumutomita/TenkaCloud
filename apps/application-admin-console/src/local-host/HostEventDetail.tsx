import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useState } from "react";
import { Navigate, useParams } from "react-router";
import { canMutateTenant, useApiClient } from "../api/client";
import {
  bulkDeployEvent,
  bulkTeardownEvent,
  EVENT_ID_RE,
  endEvent,
  lockEventScoring,
  setEventSchedule,
  unlockEventScoring,
} from "../api/events-client";
import { EventParticipantsPanel } from "../components/event-detail/EventParticipantsPanel";
import { EventTeamsPanel } from "../components/event-detail/EventTeamsPanel";
import { TeamRankingPanel } from "../components/TeamRankingPanel";
import { TeamScoreEventsPanel } from "../components/TeamScoreEventsPanel";
import type { AppConfig } from "../config";
import { useEventDetail } from "../hooks/useEventDetail";
import { useT } from "../i18n";

export function HostEventDetail({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const api = useApiClient(config);
  const canMutate = canMutateTenant(api);
  const t = useT();
  const valid = !!eventId && EVENT_ID_RE.test(eventId);
  const { detail, error, refresh, manualRefresh, manualRefreshInFlight } = useEventDetail({
    apiClient: api,
    eventId,
    eventIdValid: valid,
    withTeamLoginKeys: canMutate,
  });
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [confirmation, setConfirmation] = useState<"end" | "teardown" | null>(null);
  async function operate(operation: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setFailure("");
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "操作に失敗しました。");
    } finally {
      setBusy(false);
    }
  }
  if (!valid || !eventId) return <Navigate to="/events" replace />;
  if (!detail || !api)
    return error ? (
      <Alert type="error">{error}</Alert>
    ) : (
      <StatusIndicator type="loading">イベントを読み込んでいます</StatusIndicator>
    );
  const jobs = Object.values(detail.deploymentsByProblem).flat();
  const failed = jobs.filter((job) => job.status === "FAILED");
  const durationValid = /^\d+$/u.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 360;
  const running = detail.status === "READY" && !!detail.startsAt;
  const blocked = busy || !canMutate;
  return (
    <SpaceBetween size="l">
      <Header
        variant="h2"
        description={`${detail.status} · ${detail.teamCount}チーム / ${detail.problemCount}問`}
        actions={
          <Button loading={manualRefreshInFlight} onClick={() => void manualRefresh()}>
            最新の状態に更新
          </Button>
        }
      >
        {detail.name}
      </Header>
      {(failure || error) && <Alert type="error">{failure || error}</Alert>}
      {failed.length > 0 && (
        <Alert type="error">
          {failed.length}
          件の環境処理に失敗しました。Dockerの起動状態を確認し、再試行または撤収してください。問題環境が動いていない状態を成功として扱うことはありません。
        </Alert>
      )}
      <Container header={<Header variant="h3">開催操作</Header>}>
        <SpaceBetween size="l">
          <p>
            準備完了 {jobs.filter((job) => job.status === "COMPLETE").length} /{" "}
            {detail.teamCount * detail.problemCount}
            。環境準備後に参加キーを配布し、「競技開始」で採点を有効にします。
          </p>
          <FormField label="競技時間（分、1〜360）">
            <Input
              value={minutes}
              type="number"
              disabled={running}
              onChange={({ detail: change }) => setMinutes(change.value)}
            />
          </FormField>
          <SpaceBetween direction="horizontal" size="s">
            <Button
              disabled={blocked || !["DRAFT", "DEPLOYING"].includes(detail.status)}
              loading={busy}
              onClick={() => void operate(() => bulkDeployEvent(api, eventId))}
            >
              問題環境を準備・再試行
            </Button>
            <Button
              variant="primary"
              disabled={blocked || detail.status !== "READY" || running || !durationValid}
              onClick={() =>
                void operate(() =>
                  setEventSchedule(api, eventId, {
                    startNow: true,
                    endsAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString(),
                  }),
                )
              }
            >
              競技開始
            </Button>
            <Button disabled={blocked || !running} onClick={() => setConfirmation("end")}>
              競技終了
            </Button>
            <Button
              disabled={blocked || !["READY", "ENDED"].includes(detail.status)}
              onClick={() =>
                void operate(() =>
                  detail.scoringLocked
                    ? unlockEventScoring(api, eventId)
                    : lockEventScoring(api, eventId),
                )
              }
            >
              {detail.scoringLocked ? "採点ロック解除" : "採点をロック"}
            </Button>
            <Button
              disabled={
                blocked || jobs.length === 0 || jobs.every((job) => job.status === "DELETED")
              }
              onClick={() => setConfirmation("teardown")}
            >
              問題環境を撤収
            </Button>
          </SpaceBetween>
          {detail.startsAt && (
            <p>
              開始: {new Date(detail.startsAt).toLocaleString()} / 終了:{" "}
              {detail.endsAt ? new Date(detail.endsAt).toLocaleString() : "未設定"}
            </p>
          )}
        </SpaceBetween>
      </Container>
      <EventParticipantsPanel config={config} detail={detail} t={t} />
      <EventTeamsPanel
        apiClient={api}
        canMutateTenant={canMutate}
        detail={detail}
        onRefresh={() => void refresh()}
        t={t}
      />
      {detail.scoreEventsByTeam && <TeamRankingPanel teams={detail.scoreEventsByTeam} />}
      {detail.scoreEventsByTeam && (
        <TeamScoreEventsPanel teams={detail.scoreEventsByTeam} startsAt={detail.startsAt} />
      )}
      <Modal
        visible={confirmation !== null}
        onDismiss={() => setConfirmation(null)}
        header={confirmation === "end" ? "競技を終了しますか" : "問題環境を撤収しますか"}
        footer={
          <SpaceBetween direction="horizontal" size="s">
            <Button onClick={() => setConfirmation(null)}>キャンセル</Button>
            <Button
              variant="primary"
              onClick={() => {
                const action = confirmation;
                setConfirmation(null);
                if (action)
                  void operate(() =>
                    action === "end" ? endEvent(api, eventId) : bulkTeardownEvent(api, eventId),
                  );
              }}
            >
              実行
            </Button>
          </SpaceBetween>
        }
      >
        {confirmation === "end"
          ? "以降の回答提出とヒント利用を停止します。得点・結果は保存されます。"
          : "このイベントのチーム別Docker環境を削除します。保存済みのイベント・提出結果・得点は残ります。"}
      </Modal>
    </SpaceBetween>
  );
}

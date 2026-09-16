import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { usePolling } from "@tenkacloud/web-kit";
import { useState } from "react";
import { Navigate, useParams } from "react-router";
import { type ApiClient, canMutateTenant, useApiClient } from "../api/client";
import {
  bulkDeployEvent,
  bulkTeardownEvent,
  EVENT_ID_RE,
  type EventDeploymentSummary,
  type EventDetail,
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

/** Environment operations take seconds to minutes; 3s keeps the job table live without load. */
const JOB_POLL_INTERVAL_MS = 3_000;
const IN_FLIGHT_STATUSES = new Set(["PENDING", "IN_PROGRESS", "DELETING"]);

type Confirmation = "end" | "teardown";
type Operation = () => Promise<unknown>;

function jobsOf(detail: EventDetail | null): readonly EventDeploymentSummary[] {
  return Object.values(detail?.deploymentsByProblem ?? {}).flat();
}

function isDurationValid(minutes: string): boolean {
  return /^\d+$/u.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 360;
}

function EventTimes({ detail }: { detail: EventDetail }) {
  if (!detail.startsAt) return null;
  const endsAt = detail.endsAt ? new Date(detail.endsAt).toLocaleString() : "未設定";
  return (
    <p>
      開始: {new Date(detail.startsAt).toLocaleString()} / 終了: {endsAt}
    </p>
  );
}

function OperationButtons(props: {
  api: ApiClient;
  eventId: string;
  detail: EventDetail;
  jobs: readonly EventDeploymentSummary[];
  minutes: string;
  busy: boolean;
  blocked: boolean;
  operate: (operation: Operation) => void;
  confirm: (confirmation: Confirmation) => void;
}) {
  const { api, eventId, detail, jobs, minutes, busy, blocked, operate, confirm } = props;
  const running = detail.status === "READY" && !!detail.startsAt;
  const deployable = detail.status === "DRAFT" || detail.status === "DEPLOYING";
  const lockable = detail.status === "READY" || detail.status === "ENDED";
  const nothingToTearDown = jobs.length === 0 || jobs.every((job) => job.status === "DELETED");
  const start = () =>
    setEventSchedule(api, eventId, {
      startNow: true,
      endsAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString(),
    });
  const toggleLock = () =>
    detail.scoringLocked ? unlockEventScoring(api, eventId) : lockEventScoring(api, eventId);
  return (
    <SpaceBetween direction="horizontal" size="s">
      <Button
        disabled={blocked || !deployable}
        loading={busy}
        onClick={() => operate(() => bulkDeployEvent(api, eventId))}
      >
        問題環境を準備・再試行
      </Button>
      <Button
        variant="primary"
        disabled={blocked || detail.status !== "READY" || running || !isDurationValid(minutes)}
        onClick={() => operate(start)}
      >
        競技開始
      </Button>
      <Button disabled={blocked || !running} onClick={() => confirm("end")}>
        競技終了
      </Button>
      <Button disabled={blocked || !lockable} onClick={() => operate(toggleLock)}>
        {detail.scoringLocked ? "採点ロック解除" : "採点をロック"}
      </Button>
      <Button disabled={blocked || nothingToTearDown} onClick={() => confirm("teardown")}>
        問題環境を撤収
      </Button>
    </SpaceBetween>
  );
}

function ConfirmationModal(props: {
  confirmation: Confirmation | null;
  onDismiss: () => void;
  onConfirm: (confirmation: Confirmation) => void;
}) {
  const { confirmation, onDismiss, onConfirm } = props;
  return (
    <Modal
      visible={confirmation !== null}
      onDismiss={onDismiss}
      header={confirmation === "end" ? "競技を終了しますか" : "問題環境を撤収しますか"}
      footer={
        <SpaceBetween direction="horizontal" size="s">
          <Button onClick={onDismiss}>キャンセル</Button>
          <Button variant="primary" onClick={() => confirmation && onConfirm(confirmation)}>
            実行
          </Button>
        </SpaceBetween>
      }
    >
      {confirmation === "end"
        ? "以降の回答提出とヒント利用を停止します。得点・結果は保存されます。"
        : "このイベントのチーム別Docker環境を削除します。保存済みのイベント・提出結果・得点は残ります。"}
    </Modal>
  );
}

function EventOperations(props: {
  api: ApiClient;
  eventId: string;
  detail: EventDetail;
  jobs: readonly EventDeploymentSummary[];
  busy: boolean;
  canMutate: boolean;
  operate: (operation: Operation) => void;
  confirm: (confirmation: Confirmation) => void;
}) {
  const { api, eventId, detail, jobs, busy, canMutate, operate, confirm } = props;
  const [minutes, setMinutes] = useState("60");
  const failed = jobs.filter((job) => job.status === "FAILED").length;
  const ready = jobs.filter((job) => job.status === "COMPLETE").length;
  const running = detail.status === "READY" && !!detail.startsAt;
  return (
    <>
      {failed > 0 && (
        <Alert type="error">
          {failed}
          件の環境処理に失敗しました。Dockerの起動状態を確認し、再試行または撤収してください。問題環境が動いていない状態を成功として扱うことはありません。
        </Alert>
      )}
      <Container header={<Header variant="h3">開催操作</Header>}>
        <SpaceBetween size="l">
          <p>
            準備完了 {ready} / {detail.teamCount * detail.problemCount}
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
          <OperationButtons
            api={api}
            eventId={eventId}
            detail={detail}
            jobs={jobs}
            minutes={minutes}
            busy={busy}
            blocked={busy || !canMutate}
            operate={operate}
            confirm={confirm}
          />
          <EventTimes detail={detail} />
        </SpaceBetween>
      </Container>
    </>
  );
}

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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const jobs = jobsOf(detail);
  // Deploy and teardown answer 202 and finish in the background; the shared hook only polls
  // while the event is running, so follow nonterminal jobs here until they settle.
  const jobsInFlight = jobs.some((job) => IN_FLIGHT_STATUSES.has(job.status));
  usePolling(refresh, JOB_POLL_INTERVAL_MS, { immediate: false, enabled: jobsInFlight && !!api });
  async function operate(operation: Operation): Promise<void> {
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
  if (!detail || !api) {
    if (error) return <Alert type="error">{error}</Alert>;
    return <StatusIndicator type="loading">イベントを読み込んでいます</StatusIndicator>;
  }
  const confirmed = (action: Confirmation) => {
    setConfirmation(null);
    void operate(() =>
      action === "end" ? endEvent(api, eventId) : bulkTeardownEvent(api, eventId),
    );
  };
  const message = failure || error;
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
      {message && <Alert type="error">{message}</Alert>}
      <EventOperations
        api={api}
        eventId={eventId}
        detail={detail}
        jobs={jobs}
        busy={busy}
        canMutate={canMutate}
        operate={(operation) => void operate(operation)}
        confirm={setConfirmation}
      />
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
      <ConfirmationModal
        confirmation={confirmation}
        onDismiss={() => setConfirmation(null)}
        onConfirm={confirmed}
      />
    </SpaceBetween>
  );
}

import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import {
  type BulkResult,
  bulkDeployEvent,
  bulkTeardownEvent,
  EVENT_ID_RE,
  type EventDetail,
  type EventStatus,
  getEvent,
} from "../api/events-client";
import type { AppConfig } from "../config";

const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

export function EventDetailPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const apiClient = useApiClient(config);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [bulkInFlight, setBulkInFlight] = useState<"deploy" | "teardown" | null>(null);
  const [confirmTeardown, setConfirmTeardown] = useState(false);

  const eventIdValid = !!eventId && EVENT_ID_RE.test(eventId);

  const refresh = useCallback(async () => {
    if (!apiClient || !eventIdValid || !eventId) return;
    try {
      const d = await getEvent(apiClient, eventId);
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiClient, eventId, eventIdValid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!eventIdValid || !eventId) {
    return <Navigate to="/events" replace />;
  }

  const handleBulkDeploy = async () => {
    if (!apiClient || bulkInFlight) return;
    setBulkInFlight("deploy");
    setError(null);
    try {
      const res = await bulkDeployEvent(apiClient, eventId);
      setBulkResult(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkInFlight(null);
    }
  };

  const handleBulkTeardown = async () => {
    if (!apiClient || bulkInFlight) return;
    setBulkInFlight("teardown");
    setConfirmTeardown(false);
    setError(null);
    try {
      const res = await bulkTeardownEvent(apiClient, eventId);
      setBulkResult(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkInFlight(null);
    }
  };

  if (!detail && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 読み込み中…
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => navigate("/events")}>一覧へ戻る</Button>
            <Button
              variant="primary"
              loading={bulkInFlight === "deploy"}
              disabled={!detail || detail.problems.length === 0 || detail.teams.length === 0}
              onClick={handleBulkDeploy}
            >
              Bulk Deploy
            </Button>
            <Button
              loading={bulkInFlight === "teardown"}
              disabled={!detail}
              onClick={() => setConfirmTeardown(true)}
            >
              Bulk Teardown
            </Button>
          </SpaceBetween>
        }
      >
        {detail?.name ?? "(loading)"}
      </Header>

      {error && (
        <Alert type="error" header="エラー">
          {error}
        </Alert>
      )}
      {bulkResult && (
        <Alert
          type="success"
          dismissible
          onDismiss={() => setBulkResult(null)}
          header="Bulk 操作 受付"
        >
          受付: {bulkResult.enqueued} 件 / skipped: {bulkResult.skipped} 件 (実 deploy / delete は
          State Machine が非同期に進めます。数分後に再読み込みしてください)
        </Alert>
      )}

      {detail && (
        <Container header={<Header variant="h2">Event 概要</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            <Field label="ステータス">
              <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>
            </Field>
            <Field label="チーム数">{detail.teamCount}</Field>
            <Field label="問題数">{detail.problems.length}</Field>
            <Field label="作成">{detail.createdAt}</Field>
          </ColumnLayout>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description="このイベントで使う問題と、各問題の deploy 先 (account / region)"
            >
              問題セット ({detail.problems.length} 問)
            </Header>
          }
        >
          <Table
            variant="embedded"
            items={[...detail.problems]}
            columnDefinitions={[
              { id: "id", header: "Problem ID", cell: (p) => <code>{p.problemId}</code> },
              { id: "account", header: "Default AWS Account", cell: (p) => p.defaultAwsAccountId },
              { id: "region", header: "Default Region", cell: (p) => p.defaultRegion },
            ]}
            empty={<Box>未設定 — Event 編集 (Phase 2c+) で追加できる予定</Box>}
          />
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description="teamLoginKey は作成完了時に 1 度だけ表示されたキーです。再表示はできません。"
            >
              チーム ({detail.teams.length})
            </Header>
          }
        >
          <Table
            variant="embedded"
            items={[...detail.teams]}
            columnDefinitions={[
              { id: "slug", header: "Internal Slug", cell: (t) => <code>{t.internalSlug}</code> },
              {
                id: "displayName",
                header: "表示名 (競技者選択)",
                cell: (t) =>
                  t.displayName ?? (
                    <Box variant="small" color="text-status-inactive">
                      (未設定)
                    </Box>
                  ),
              },
              {
                id: "key",
                header: "teamLoginKey",
                cell: (t) =>
                  t.teamLoginKey ? (
                    <Box variant="code" fontSize="body-s">
                      {t.teamLoginKey}
                    </Box>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      (詳細で再表示可)
                    </Box>
                  ),
              },
            ]}
            empty={<Box>チームがありません</Box>}
          />
        </Container>
      )}

      <Modal
        visible={confirmTeardown}
        header="Bulk Teardown を実行しますか?"
        onDismiss={() => setConfirmTeardown(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmTeardown(false)}>キャンセル</Button>
              <Button variant="primary" onClick={handleBulkTeardown}>
                実行
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            このイベント配下の全 deployment を <code>DELETING</code> 状態に倒し、CFn DeleteStack
            を非同期実行します。teams × problems の組み合わせ全てが対象です。
          </Box>
          <Box variant="small" color="text-status-warning">
            既に DELETING / DELETED な行は idempotent で skip されます。Phase 3+ で
            「失敗した行のみ再試行」を追加予定です。
          </Box>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}

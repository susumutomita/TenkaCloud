import Alert from "@cloudscape-design/components/alert";
import Badge, { type BadgeProps } from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { type App, deleteApp, listApps } from "../api/apps";
import { useApiClient } from "../api/client";
import type { AppConfig } from "../config";

const STATUS_BADGE_COLOR: Partial<Record<string, BadgeProps["color"]>> = {
  active: "green",
  pending: "blue",
};

export function AppsPage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();
  const api = useApiClient(config);
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<App | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setError(null);
      setApps(await listApps(api));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const confirmDelete = async () => {
    if (!api || !pendingDelete) return;
    try {
      await deleteApp(api, pendingDelete.appId);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`${config.tenantName} の公開アプリ一覧`}
        actions={
          <Button variant="primary" onClick={() => navigate("/apps/new")}>
            アプリを公開する
          </Button>
        }
      >
        公開アプリ
      </Header>

      {error && (
        <Alert
          type="error"
          header="取得に失敗しました"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <Table
        variant="container"
        loading={apps === null && error === null}
        loadingText="読み込み中..."
        items={apps ?? []}
        trackBy="appId"
        empty={
          <Box textAlign="center" color="inherit">
            公開アプリがまだありません。「アプリを公開する」から作成してください。
          </Box>
        }
        columnDefinitions={[
          { id: "name", header: "名称", cell: (a) => a.name },
          { id: "upstreamUrl", header: "Upstream", cell: (a) => a.upstreamUrl },
          {
            id: "status",
            header: "状態",
            cell: (a) => <Badge color={STATUS_BADGE_COLOR[a.status] ?? "grey"}>{a.status}</Badge>,
          },
          {
            id: "authProvider",
            header: "認証",
            cell: (a) => (a.authProvider === "CognitoSamlEntraBroker" ? "Entra SAML" : "Cognito"),
          },
          {
            id: "functionUrl",
            header: "公開 URL",
            cell: (a) =>
              a.functionUrl ? (
                <Button variant="inline-link" href={a.functionUrl} target="_blank">
                  開く ↗
                </Button>
              ) : (
                <Box color="text-status-inactive" variant="small">
                  発行中
                </Box>
              ),
          },
          {
            id: "actions",
            header: "操作",
            cell: (a) => (
              <Button variant="inline-link" onClick={() => setPendingDelete(a)}>
                取り下げ
              </Button>
            ),
          },
        ]}
      />

      <Modal
        visible={pendingDelete !== null}
        header="公開を取り下げますか?"
        onDismiss={() => setPendingDelete(null)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setPendingDelete(null)}>
                キャンセル
              </Button>
              <Button variant="primary" onClick={confirmDelete}>
                取り下げ
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {pendingDelete && (
          <Box variant="p">
            {pendingDelete.name} ({pendingDelete.upstreamUrl}) の公開を取り下げます。 per-app Lambda
            と Function URL が AWS から削除されます。
          </Box>
        )}
      </Modal>
    </SpaceBetween>
  );
}

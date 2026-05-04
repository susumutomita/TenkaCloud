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
import { useApiClient } from "../api/client";
import {
  buildCodeBuildBuildUrl,
  deleteTenant,
  listTenants,
  parseTenantConfig,
  type Tenant,
  type TenantStatus,
} from "../api/tenants";
import type { AppConfig } from "../config";

const STATUS_BADGE_COLOR: Partial<Record<TenantStatus, BadgeProps["color"]>> = {
  ACTIVE: "green",
  PROVISIONING: "blue",
  DEPROVISIONING: "grey",
  DELETED: "grey",
};

function statusBadgeColor(tenantStatus: string): BadgeProps["color"] {
  return STATUS_BADGE_COLOR[tenantStatus as TenantStatus] ?? "grey";
}

/**
 * deprovision 済みの tenant かどうかを判定する。
 *   - tenantStatus が "Deleted" / "DELETED" / "Deprovisioned" のいずれか
 *   - または isActive === false (SBT v0.3.9 の DELETE /tenants は isActive = false にする)
 *
 * 該当する行は Application Console / ログ / 操作 カラムをすべて灰色 "(deprovisioned)"
 * 表示にし、active なリンクは出さない。
 */
function isDeprovisioned(t: Tenant): boolean {
  const status = (t.tenantStatus ?? "").toLowerCase();
  if (status === "deleted" || status === "deprovisioned") return true;
  if (t.isActive === false) return true;
  return false;
}

function inactiveCell(label = "(deprovisioned)") {
  return (
    <Box color="text-status-inactive" variant="small">
      {label}
    </Box>
  );
}

export function TenantListPage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();
  const api = useApiClient(config);
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeprovision, setPendingDeprovision] = useState<Tenant | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setError(null);
      setTenants(await listTenants(api));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const confirmDeprovision = async () => {
    if (!api || !pendingDeprovision) return;
    try {
      await deleteTenant(api, pendingDeprovision.tenantId);
      setPendingDeprovision(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button variant="primary" onClick={() => navigate("/tenants/new")}>
            新規テナント作成
          </Button>
        }
      >
        テナント一覧
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
        loading={tenants === null && error === null}
        loadingText="読み込み中..."
        items={tenants ?? []}
        trackBy="tenantId"
        empty={
          <Box textAlign="center" color="inherit">
            テナントがまだ登録されていません。
          </Box>
        }
        columnDefinitions={[
          { id: "tenantId", header: "テナント ID", cell: (t) => t.tenantId },
          { id: "tenantName", header: "名称", cell: (t) => t.tenantName },
          { id: "email", header: "管理者メール", cell: (t) => t.email },
          { id: "tier", header: "Tier", cell: (t) => <Badge>{t.tier}</Badge> },
          {
            id: "status",
            header: "状態",
            cell: (t) => <Badge color={statusBadgeColor(t.tenantStatus)}>{t.tenantStatus}</Badge>,
          },
          {
            id: "appConsole",
            header: "Application Console",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              const parsed = parseTenantConfig(t.tenantConfig);
              // silo 判定は tier label ではなく URL の実存で行う (旧 premium tier との
              // 後方互換も同時に解決される)。tenantConfig に applicationAdminConsoleUrl
              // が乗っていれば silo deploy 済み。無ければ pooled stack の共有 URL を使う。
              const siloUrl = parsed.applicationAdminConsoleUrl;
              const url = siloUrl || config.pooledApplicationAdminConsoleUrl || undefined;
              if (!url) {
                return inactiveCell("未発行 (deploy 完了後に表示)");
              }
              const isSilo = Boolean(siloUrl);
              return (
                <Button
                  variant="inline-link"
                  href={url}
                  target="_blank"
                  ariaLabel={`${t.tenantName} の Application Admin Console を新規タブで開く`}
                >
                  開く ↗{isSilo ? "" : " (pooled 共有)"}
                </Button>
              );
            },
          },
          {
            id: "logs",
            header: "ログ",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              const parsed = parseTenantConfig(t.tenantConfig);
              const url = buildCodeBuildBuildUrl({
                buildId: parsed.provisioningBuildId,
                projectName: parsed.provisioningProjectName ?? config.provisioningCodeBuildProject,
                region: parsed.provisioningRegion ?? config.awsRegion,
                accountId: parsed.provisioningAccountId ?? config.awsAccountId,
              });
              if (!url) {
                // silo (= tenantConfig に build 情報あり) でないと build deep link 出せない
                const isSilo = Boolean(parsed.applicationAdminConsoleUrl);
                return inactiveCell(isSilo ? "未発行" : "(pooled)");
              }
              return (
                <Button
                  variant="inline-link"
                  href={url}
                  target="_blank"
                  ariaLabel={`${t.tenantName} の provisioning build を AWS Console で開く`}
                >
                  CodeBuild ↗
                </Button>
              );
            },
          },
          {
            id: "actions",
            header: "操作",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              return (
                <Button variant="inline-link" onClick={() => setPendingDeprovision(t)}>
                  deprovision
                </Button>
              );
            },
          },
        ]}
      />

      <Modal
        visible={pendingDeprovision !== null}
        header={`テナントを deprovision しますか？`}
        onDismiss={() => setPendingDeprovision(null)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setPendingDeprovision(null)}>
                キャンセル
              </Button>
              <Button variant="primary" onClick={confirmDeprovision}>
                実行
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {pendingDeprovision && (
          <Box variant="p">
            {pendingDeprovision.tenantName} ({pendingDeprovision.tenantId}) を deprovision します。
            関連する CloudFormation スタックと DynamoDB レコードが削除されます。
          </Box>
        )}
      </Modal>
    </SpaceBetween>
  );
}

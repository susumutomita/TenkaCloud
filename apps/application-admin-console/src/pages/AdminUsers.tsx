import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
import { type ApiClient, useApiClient } from "../api/client";
import {
  deleteTenantUser,
  inviteTenantUser,
  listTenantUsers,
  type TenantUserSummary,
} from "../api/tenant-users-client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

/**
 * Issue #925 Phase 1: Tenant Admin が tenant 内 user を管理する画面。
 *
 * UI flow:
 *   1. mount で GET /admin/users → 一覧表示
 *   2. 「招待」 button → email + role (= TenantAdmin 固定 for now) modal → POST /admin/users
 *   3. 行ごとの 「削除」 → 確認 modal → DELETE /admin/users/{username}
 *
 * 重要:
 *   - 自分自身は削除できない (server 側で 409 cannot_delete_self、 UI でも button disable)
 *   - role 選択は #926 で TenantViewer / TenantOperator を追加するまで TenantAdmin 固定
 */
export function AdminUsersPage({ config }: { config: AppConfig }) {
  const t = useT();
  const apiClient = useApiClient(config);
  const [users, setUsers] = useState<TenantUserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TenantUserSummary | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiClient) return;
    setLoading(true);
    setLoadError(null);
    try {
      const items = await listTenantUsers(apiClient as ApiClient);
      setUsers(items);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInvite = useCallback(async () => {
    if (!apiClient || inviteEmail.trim().length === 0) return;
    setInviteSubmitting(true);
    setInviteError(null);
    try {
      await inviteTenantUser(apiClient as ApiClient, { email: inviteEmail.trim() });
      setInviteEmail("");
      setInviteModal(false);
      setSuccessMessage(t("users.invite_success", { email: inviteEmail.trim() }));
      await refresh();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteSubmitting(false);
    }
  }, [apiClient, inviteEmail, refresh, t]);

  const handleDelete = useCallback(async () => {
    if (!apiClient || !deleteTarget) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await deleteTenantUser(apiClient as ApiClient, deleteTarget.username);
      setSuccessMessage(
        t("users.delete_success", { email: deleteTarget.email ?? deleteTarget.username }),
      );
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteSubmitting(false);
    }
  }, [apiClient, deleteTarget, refresh, t]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("users.description")}
        actions={
          <Button variant="primary" onClick={() => setInviteModal(true)}>
            {t("users.invite_button")}
          </Button>
        }
      >
        {t("users.header")}
      </Header>
      {successMessage && (
        <Alert type="success" dismissible onDismiss={() => setSuccessMessage(null)}>
          {successMessage}
        </Alert>
      )}
      {loadError && (
        <Alert type="error" header={t("users.load_error_header")}>
          {loadError}
        </Alert>
      )}
      <Container>
        <Table
          loading={loading}
          loadingText={t("app.loading")}
          items={users}
          columnDefinitions={[
            {
              id: "email",
              header: t("users.col_email"),
              cell: (u) => u.email ?? u.username,
            },
            {
              id: "role",
              header: t("users.col_role"),
              cell: (u) => u.userRole ?? "—",
            },
            {
              id: "status",
              header: t("users.col_status"),
              cell: (u) =>
                u.status === "CONFIRMED"
                  ? t("users.status_confirmed")
                  : u.status === "FORCE_CHANGE_PASSWORD"
                    ? t("users.status_pending")
                    : (u.status ?? "—"),
            },
            {
              id: "createdAt",
              header: t("users.col_created_at"),
              cell: (u) => (u.createdAt ? new Date(u.createdAt).toLocaleString() : "—"),
            },
            {
              id: "actions",
              header: t("users.col_actions"),
              cell: (u) => (
                <Button
                  variant="link"
                  onClick={() => setDeleteTarget(u)}
                  ariaLabel={t("users.delete_aria", {
                    email: u.email ?? u.username,
                  })}
                >
                  {t("users.delete_button")}
                </Button>
              ),
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit">
              {t("users.empty")}
            </Box>
          }
        />
      </Container>

      <Modal
        visible={inviteModal}
        onDismiss={() => {
          setInviteModal(false);
          setInviteError(null);
        }}
        header={t("users.invite_modal_header")}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setInviteModal(false);
                  setInviteError(null);
                }}
              >
                {t("users.modal_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={inviteSubmitting}
                disabled={inviteEmail.trim().length === 0}
                onClick={() => void handleInvite()}
              >
                {t("users.invite_submit")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>{t("users.invite_modal_body")}</Box>
          <Form>
            <FormField label={t("users.field_email")} description={t("users.field_email_desc")}>
              <Input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.detail.value)}
                placeholder="user@example.com"
                type="email"
              />
            </FormField>
            <FormField label={t("users.field_role")} description={t("users.field_role_desc")}>
              <Box>{t("users.role_tenant_admin")}</Box>
            </FormField>
          </Form>
          {inviteError && (
            <Alert type="error" header={t("users.invite_error_header")}>
              {inviteError}
            </Alert>
          )}
        </SpaceBetween>
      </Modal>

      <Modal
        visible={deleteTarget !== null}
        onDismiss={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        header={t("users.delete_modal_header")}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteError(null);
                }}
              >
                {t("users.modal_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={deleteSubmitting}
                onClick={() => void handleDelete()}
              >
                {t("users.delete_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            {t("users.delete_modal_body", {
              email: deleteTarget?.email ?? deleteTarget?.username ?? "",
            })}
          </Box>
          {deleteError && (
            <Alert type="error" header={t("users.delete_error_header")}>
              {deleteError}
            </Alert>
          )}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

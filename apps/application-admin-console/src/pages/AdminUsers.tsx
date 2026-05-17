import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
import { type ApiClient, useApiClient } from "../api/client";
import {
  changeTenantUserRole,
  deleteTenantUser,
  inviteTenantUser,
  listTenantUsers,
  TENANT_ROLE_OPTIONS,
  type TenantRole,
  type TenantUserSummary,
} from "../api/tenant-users-client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

/**
 * Issue #925 Phase 1 + #926 Phase B (= ADR-020): Tenant Admin が tenant 内 user を管理する画面。
 *
 * UI flow:
 *   1. mount で GET /admin/users → 一覧表示
 *   2. 「招待」 button → email + role (= TenantAdmin / TenantOperator / TenantViewer 選択) modal → POST /admin/users
 *   3. 行ごとの 「削除」 → 確認 modal → DELETE /admin/users/{username}
 *
 * 重要:
 *   - 自分自身は削除できない (server 側で 409 cannot_delete_self)
 *   - role enum は 3 種類 (ADR-020 / #926 Phase B)。 ただし Phase B.1 で route 単位 granular check
 *     が入るまで destructive route は admin gate のまま (= Operator / Viewer 招待しても admin 系で 403)
 */
export function AdminUsersPage({ config }: { config: AppConfig }) {
  const t = useT();
  const apiClient = useApiClient(config);
  const [users, setUsers] = useState<TenantUserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TenantRole>("TenantAdmin");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TenantUserSummary | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Issue #17: role 変更 modal state。 selected role は user の現在 role を初期値にする。
  const [roleChangeTarget, setRoleChangeTarget] = useState<TenantUserSummary | null>(null);
  const [roleChangeNew, setRoleChangeNew] = useState<TenantRole>("TenantAdmin");
  const [roleChangeSubmitting, setRoleChangeSubmitting] = useState(false);
  const [roleChangeError, setRoleChangeError] = useState<string | null>(null);

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
      await inviteTenantUser(apiClient as ApiClient, {
        email: inviteEmail.trim(),
        userRole: inviteRole,
      });
      setInviteEmail("");
      setInviteRole("TenantAdmin");
      setInviteModal(false);
      setSuccessMessage(t("users.invite_success", { email: inviteEmail.trim() }));
      await refresh();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteSubmitting(false);
    }
  }, [apiClient, inviteEmail, inviteRole, refresh, t]);

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

  // Issue #17: role 変更 submit。 server 側 (= AdminUpdateUserAttributes) で実 attribute を書き換え。
  const handleRoleChange = useCallback(async () => {
    if (!apiClient || !roleChangeTarget) return;
    setRoleChangeSubmitting(true);
    setRoleChangeError(null);
    try {
      await changeTenantUserRole(apiClient as ApiClient, roleChangeTarget.username, roleChangeNew);
      setSuccessMessage(
        t("users.role_change_success", {
          email: roleChangeTarget.email ?? roleChangeTarget.username,
          role: roleChangeNew,
        }),
      );
      setRoleChangeTarget(null);
      await refresh();
    } catch (err) {
      setRoleChangeError(err instanceof Error ? err.message : String(err));
    } finally {
      setRoleChangeSubmitting(false);
    }
  }, [apiClient, roleChangeTarget, roleChangeNew, refresh, t]);

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
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="link"
                    onClick={() => {
                      setRoleChangeTarget(u);
                      // 初期値は現在 role (= 未設定なら Viewer に倒す)
                      setRoleChangeNew((u.userRole as TenantRole | undefined) ?? "TenantViewer");
                    }}
                    ariaLabel={t("users.role_change_aria", {
                      email: u.email ?? u.username,
                    })}
                  >
                    {t("users.role_change_button")}
                  </Button>
                  <Button
                    variant="link"
                    onClick={() => setDeleteTarget(u)}
                    ariaLabel={t("users.delete_aria", {
                      email: u.email ?? u.username,
                    })}
                  >
                    {t("users.delete_button")}
                  </Button>
                </SpaceBetween>
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
              <Select
                selectedOption={{
                  value: inviteRole,
                  label: t(`users.role_${inviteRole.replace("Tenant", "tenant_").toLowerCase()}`),
                }}
                onChange={(e) => {
                  if (e.detail.selectedOption.value)
                    setInviteRole(e.detail.selectedOption.value as TenantRole);
                }}
                options={TENANT_ROLE_OPTIONS.map((role) => ({
                  value: role,
                  label: t(`users.role_${role.replace("Tenant", "tenant_").toLowerCase()}`),
                  description: t(
                    `users.role_${role.replace("Tenant", "tenant_").toLowerCase()}_desc`,
                  ),
                }))}
              />
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

      {/* Issue #17: role 変更 modal。 select で新 role を選び confirm で PATCH。 */}
      <Modal
        visible={roleChangeTarget !== null}
        onDismiss={() => {
          setRoleChangeTarget(null);
          setRoleChangeError(null);
        }}
        header={t("users.role_change_modal_header")}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setRoleChangeTarget(null);
                  setRoleChangeError(null);
                }}
              >
                {t("users.modal_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={roleChangeSubmitting}
                onClick={() => void handleRoleChange()}
                disabled={roleChangeTarget?.userRole === roleChangeNew}
              >
                {t("users.role_change_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            {t("users.role_change_modal_body", {
              email: roleChangeTarget?.email ?? roleChangeTarget?.username ?? "",
              current: roleChangeTarget?.userRole ?? "—",
            })}
          </Box>
          <FormField label={t("users.field_role")} description={t("users.field_role_desc")}>
            <Select
              selectedOption={{
                value: roleChangeNew,
                label: t(`users.role_${roleChangeNew.replace("Tenant", "tenant_").toLowerCase()}`),
              }}
              onChange={(e) => {
                if (e.detail.selectedOption.value)
                  setRoleChangeNew(e.detail.selectedOption.value as TenantRole);
              }}
              options={TENANT_ROLE_OPTIONS.map((role) => ({
                value: role,
                label: t(`users.role_${role.replace("Tenant", "tenant_").toLowerCase()}`),
                description: t(
                  `users.role_${role.replace("Tenant", "tenant_").toLowerCase()}_desc`,
                ),
              }))}
            />
          </FormField>
          {roleChangeError && (
            <Alert type="error" header={t("users.role_change_error_header")}>
              {roleChangeError}
            </Alert>
          )}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

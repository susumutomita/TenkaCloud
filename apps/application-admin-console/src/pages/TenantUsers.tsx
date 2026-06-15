import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { canMutateTenant, useApiClient } from "../api/client";
import {
  changeTenantUserRole,
  deleteTenantUser,
  inviteTenantUser,
  listTenantUsers,
  type TenantUserRole,
  type TenantUserSummary,
} from "../api/users-client";
import type { AppConfig } from "../config";
import { useLang, useT } from "../i18n";
import { formatRelativeTime } from "../lib/format";

const USER_ROLES = ["TenantAdmin", "TenantOperator", "TenantViewer"] as const;
const DEFAULT_INVITE_ROLE: TenantUserRole = "TenantViewer";
const InviteFormSchema = z.object({
  email: z.string().email(),
  role: z.enum(USER_ROLES),
});

function roleOption(role: TenantUserRole, t: ReturnType<typeof useT>): SelectProps.Option {
  return { value: role, label: t(`tenant_users.role_${role}`) };
}

function roleFromOption(option: SelectProps.Option | null): TenantUserRole | undefined {
  return USER_ROLES.find((role) => role === option?.value);
}

function displayName(user: TenantUserSummary): string {
  return user.email ?? user.username;
}

export function TenantUsersPage({ config }: { config: AppConfig }) {
  const t = useT();
  const lang = useLang();
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const roleOptions = useMemo(() => USER_ROLES.map((role) => roleOption(role, t)), [t]);

  const [items, setItems] = useState<readonly TenantUserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TenantUserRole>(DEFAULT_INVITE_ROLE);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiClient) return;
    try {
      setLoadError(null);
      const res = await listTenantUsers(apiClient);
      setItems(res.items);
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }, [apiClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetInvite = () => {
    setInviteEmail("");
    setInviteRole(DEFAULT_INVITE_ROLE);
    setInviteError(null);
  };

  const closeInvite = () => {
    if (busy) return;
    setInviteOpen(false);
    resetInvite();
  };

  const handleInvite = async () => {
    /* v8 ignore next -- defensive: the invite submit button is disabled={!apiClient || !canMutate || busy}, so this guard's true branch is unreachable from the UI */
    if (!apiClient || !canMutate) return;
    const parsed = InviteFormSchema.safeParse({
      email: inviteEmail.trim(),
      role: inviteRole,
    });
    if (!parsed.success) {
      setInviteError(t("tenant_users.invite_email_invalid"));
      return;
    }
    setBusy(true);
    setInviteError(null);
    setMutationError(null);
    try {
      await inviteTenantUser(apiClient, parsed.data);
      setInviteOpen(false);
      resetInvite();
      await refresh();
    } catch (err) {
      setInviteError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (user: TenantUserSummary) => {
    /* v8 ignore next -- defensive: the delete button is disabled={!canMutate || rowBusy===...}, and a null apiClient implies !canMutate, so this guard's true branch is unreachable from the UI */
    if (!apiClient || !canMutate) return;
    const name = displayName(user);
    if (!window.confirm(t("tenant_users.delete_confirm", { username: name }))) return;
    setRowBusy(user.username);
    setMutationError(null);
    try {
      await deleteTenantUser(apiClient, user.username);
      await refresh();
    } catch (err) {
      setMutationError(toErrorMessage(err));
    } finally {
      setRowBusy(null);
    }
  };

  const handleRoleChange = async (user: TenantUserSummary, option: SelectProps.Option | null) => {
    const nextRole = roleFromOption(option);
    /* v8 ignore next -- the role Select renders only when canMutate (which implies apiClient), so the !apiClient / !canMutate operands of this guard are unreachable */
    if (!apiClient || !canMutate || !nextRole || nextRole === user.role) return;
    setRowBusy(user.username);
    setMutationError(null);
    try {
      const res = await changeTenantUserRole(apiClient, user.username, nextRole);
      setItems(
        /* v8 ignore next -- defensive: a successful role change implies the row (and items) exist, so prev is never null here; the `prev?.`/`?? prev` fallbacks are unreachable */
        (prev) => prev?.map((item) => (item.username === user.username ? res.item : item)) ?? prev,
      );
    } catch (err) {
      setMutationError(toErrorMessage(err));
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("tenant_users.description")}
        actions={
          <Button variant="primary" disabled={!canMutate} onClick={() => setInviteOpen(true)}>
            {t("tenant_users.invite_button")}
          </Button>
        }
      >
        {t("tenant_users.title")}
      </Header>

      {!canMutate ? (
        <Alert type="info" header={t("tenant_users.readonly_header")}>
          {t("tenant_users.readonly_body")}
        </Alert>
      ) : null}
      {loadError ? (
        <Alert type="error" header={t("tenant_users.load_error_header")}>
          {loadError}
        </Alert>
      ) : null}
      {mutationError ? (
        <Alert type="error" header={t("tenant_users.mutation_error_header")}>
          {mutationError}
        </Alert>
      ) : null}

      <Container>
        <Table
          columnDefinitions={[
            {
              id: "email",
              header: t("tenant_users.col_email"),
              cell: (user: TenantUserSummary) => displayName(user),
            },
            {
              id: "role",
              header: t("tenant_users.col_role"),
              cell: (user: TenantUserSummary) =>
                canMutate ? (
                  <Select
                    selectedOption={
                      user.role
                        ? (roleOptions.find((option) => option.value === user.role) ?? null)
                        : null
                    }
                    options={roleOptions}
                    onChange={(event) => void handleRoleChange(user, event.detail.selectedOption)}
                    disabled={rowBusy === user.username}
                  />
                ) : user.role ? (
                  t(`tenant_users.role_${user.role}`)
                ) : (
                  t("tenant_users.value_dash")
                ),
            },
            {
              id: "status",
              header: t("tenant_users.col_status"),
              cell: (user: TenantUserSummary) =>
                user.enabled
                  ? (user.status ?? t("tenant_users.status_enabled"))
                  : t("tenant_users.status_disabled"),
            },
            {
              id: "updatedAt",
              header: t("tenant_users.col_updated"),
              cell: (user: TenantUserSummary) =>
                user.updatedAt ? (
                  <span title={user.updatedAt}>{formatRelativeTime(user.updatedAt, lang)}</span>
                ) : (
                  t("tenant_users.value_dash")
                ),
            },
            {
              id: "actions",
              header: t("tenant_users.col_actions"),
              cell: (user: TenantUserSummary) => (
                <Button
                  iconName="remove"
                  variant="inline-link"
                  disabled={!canMutate || rowBusy === user.username}
                  loading={rowBusy === user.username}
                  onClick={() => void handleDelete(user)}
                >
                  {t("tenant_users.delete")}
                </Button>
              ),
            },
          ]}
          items={items ?? []}
          loading={items === null && !loadError}
          loadingText={t("tenant_users.loading")}
          empty={
            <Box textAlign="center" padding="l">
              <SpaceBetween size="xs">
                <Box variant="strong">{t("tenant_users.empty_header")}</Box>
                <Box color="text-body-secondary">{t("tenant_users.empty_body")}</Box>
              </SpaceBetween>
            </Box>
          }
        />
      </Container>

      <Modal
        visible={inviteOpen}
        onDismiss={closeInvite}
        header={t("tenant_users.invite_modal_header")}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={closeInvite} disabled={busy}>
                {t("tenant_users.invite_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={!apiClient || !canMutate || busy}
                onClick={handleInvite}
              >
                {t("tenant_users.invite_submit")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {inviteError ? (
            <Alert type="error" header={t("tenant_users.invite_error_header")}>
              {inviteError}
            </Alert>
          ) : null}
          <FormField
            label={t("tenant_users.invite_email_label")}
            errorText={inviteError ?? undefined}
          >
            <Input
              type="email"
              value={inviteEmail}
              onChange={(event) => {
                setInviteEmail(event.detail.value);
                setInviteError(null);
              }}
              disabled={busy}
              placeholder="operator@example.com"
            />
          </FormField>
          <FormField label={t("tenant_users.invite_role_label")}>
            <Select
              selectedOption={
                /* v8 ignore next -- defensive: inviteRole is always one of USER_ROLES and roleOptions is non-empty, so find() always matches and the `?? roleOptions[0] ?? null` fallbacks are unreachable */
                roleOptions.find((option) => option.value === inviteRole) ?? roleOptions[0] ?? null
              }
              options={roleOptions}
              onChange={(event) => {
                const next = roleFromOption(event.detail.selectedOption);
                /* v8 ignore next -- defensive: the Select's options are all valid roles, so roleFromOption always returns a role; the `!next` branch is unreachable */
                if (next) setInviteRole(next);
              }}
              disabled={busy}
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

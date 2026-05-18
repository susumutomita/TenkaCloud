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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSystemUsersClient,
  describeSystemUsersError,
  SYSTEM_ROLES,
  type SystemUserRole,
  type SystemUserSummary,
  SystemUsersApiError,
} from "../api/system-users-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * Issue #949 (ADR-020 Phase C): SystemAdmin Console 側の system user 管理画面。
 *
 * UI flow:
 *   1. mount で GET /admin/insight/system-users → 一覧表示
 *   2. 「招待」 button → email + role (= SystemAdmin / SystemAuditor) modal → POST
 *   3. 行ごとの 「role 変更」 → modal → PATCH
 *   4. 行ごとの 「削除」 → 確認 modal → DELETE
 *
 * Lock-out 防止:
 *   - 自分自身は削除できない (server 409 cannot_delete_self)
 *   - 自分自身を SystemAuditor に降格できない (server 409 cannot_demote_self)
 *
 * 設定エラー:
 *   - `adminInsightApiUrl` 未配線 (= phase 2 前) → client が null、 「未配線」 alert を表示
 */
export function SystemUsersPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const client = useMemo(
    () => (auth.tokens ? createSystemUsersClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
  );
  const [users, setUsers] = useState<SystemUserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<SystemUserRole>("SystemAdmin");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [roleTarget, setRoleTarget] = useState<SystemUserSummary | null>(null);
  const [roleNew, setRoleNew] = useState<SystemUserRole>("SystemAdmin");
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<SystemUserSummary | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setLoadError(null);
    try {
      const items = await client.list();
      setUsers(items);
    } catch (err) {
      if (err instanceof SystemUsersApiError) {
        setLoadError(describeSystemUsersError(err).fallback);
      } else if (err instanceof Error) {
        setLoadError(err.message);
      } else {
        setLoadError("一覧取得に失敗しました");
      }
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitInvite = async () => {
    if (!client) return;
    setInviteSubmitting(true);
    setInviteError(null);
    try {
      await client.invite({ email: inviteEmail, role: inviteRole });
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("SystemAdmin");
      setSuccessMessage(`${inviteEmail} を招待しました (Cognito から email が届きます)`);
      await refresh();
    } catch (err) {
      if (err instanceof SystemUsersApiError) {
        setInviteError(describeSystemUsersError(err).fallback);
      } else if (err instanceof Error) {
        setInviteError(err.message);
      } else {
        setInviteError("招待に失敗しました");
      }
    } finally {
      setInviteSubmitting(false);
    }
  };

  const submitRoleChange = async () => {
    if (!client || !roleTarget) return;
    setRoleSubmitting(true);
    setRoleError(null);
    try {
      await client.changeRole(roleTarget.username, roleNew);
      setRoleTarget(null);
      setSuccessMessage(`${roleTarget.email ?? roleTarget.username} を ${roleNew} に変更しました`);
      await refresh();
    } catch (err) {
      if (err instanceof SystemUsersApiError) {
        setRoleError(describeSystemUsersError(err).fallback);
      } else if (err instanceof Error) {
        setRoleError(err.message);
      } else {
        setRoleError("role 変更に失敗しました");
      }
    } finally {
      setRoleSubmitting(false);
    }
  };

  const submitDelete = async () => {
    if (!client || !deleteTarget) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await client.remove(deleteTarget.username);
      const removed = deleteTarget;
      setDeleteTarget(null);
      setSuccessMessage(`${removed.email ?? removed.username} を削除しました`);
      await refresh();
    } catch (err) {
      if (err instanceof SystemUsersApiError) {
        setDeleteError(describeSystemUsersError(err).fallback);
      } else if (err instanceof Error) {
        setDeleteError(err.message);
      } else {
        setDeleteError("削除に失敗しました");
      }
    } finally {
      setDeleteSubmitting(false);
    }
  };

  if (!client) {
    return (
      <Container header={<Header>SystemAdmin user 管理</Header>}>
        <Alert type="warning" header="AdminInsight stack が未配線">
          \`config.adminInsightApiUrl\` が空のため SystemAdmin user 管理 UI は利用できません。 Phase
          2 の deploy を完了して runtime-config.json に <code>adminInsightApiUrl</code>{" "}
          を注入してください。
        </Alert>
      </Container>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            SystemAdmin user を招待
          </Button>
        }
      >
        SystemAdmin user 管理
      </Header>

      {/* Issue #995: email = Cognito Username なので 「email 変更」 は技術的に不可。
       *   行き先がよく分からないユーザーに、 ここで明示する (= 「変更ボタンが無い」 を
       *   操作的にカバー)。 */}
      <Alert type="info" header="Email を変更したい場合">
        SystemAdmin user の email は Cognito Username に紐付いているため変更できません (= AWS
        Cognito の仕様)。 新しい email で SystemAdmin を 1 人 「招待」 してログイン確認した後、 旧
        user の 「削除」 を実行してください (= 自分自身を削除する経路は server 側 409 で block
        されるので、 別 SystemAdmin から削除依頼を出すか、 一時的に別 SystemAdmin を
        立てて操作してください)。
      </Alert>

      {successMessage && (
        <Alert type="success" dismissible onDismiss={() => setSuccessMessage(null)}>
          {successMessage}
        </Alert>
      )}
      {loadError && (
        <Alert type="error" header="一覧取得に失敗">
          {loadError}
        </Alert>
      )}

      <Table
        loading={loading}
        loadingText="読み込み中…"
        items={users}
        columnDefinitions={[
          {
            id: "email",
            header: "Email",
            cell: (u) => u.email ?? u.username,
          },
          {
            id: "role",
            header: "Role",
            cell: (u) => u.groups.join(", ") || "(未割当)",
          },
          {
            id: "status",
            header: "状態",
            cell: (u) => `${u.enabled === false ? "(無効) " : ""}${u.status ?? "-"}`,
          },
          {
            id: "createdAt",
            header: "作成日時",
            cell: (u) => u.createdAt ?? "-",
          },
          {
            id: "actions",
            header: "操作",
            cell: (u) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="normal"
                  onClick={() => {
                    setRoleTarget(u);
                    setRoleNew((u.groups[0] ?? "SystemAdmin") as SystemUserRole);
                    setRoleError(null);
                  }}
                >
                  role 変更
                </Button>
                <Button
                  variant="normal"
                  onClick={() => {
                    setDeleteTarget(u);
                    setDeleteError(null);
                  }}
                >
                  削除
                </Button>
              </SpaceBetween>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" padding="m">
            <SpaceBetween size="s">
              <b>SystemAdmin user が 1 人もいません</b>
              <Button variant="primary" onClick={() => setInviteOpen(true)}>
                招待する
              </Button>
            </SpaceBetween>
          </Box>
        }
      />

      <Modal
        visible={inviteOpen}
        onDismiss={() => setInviteOpen(false)}
        header="SystemAdmin user を招待"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setInviteOpen(false)}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={submitInvite}
                loading={inviteSubmitting}
                disabled={!inviteEmail || inviteSubmitting}
              >
                招待 email を送信
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween size="m">
            {inviteError && <Alert type="error">{inviteError}</Alert>}
            <FormField label="Email" description="招待 email の宛先 + Cognito Username になります">
              <Input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.detail.value)}
                placeholder="user@example.com"
              />
            </FormField>
            <FormField label="Role">
              <Select
                selectedOption={{ value: inviteRole, label: inviteRole }}
                options={SYSTEM_ROLES.map((r) => ({ value: r, label: r }))}
                onChange={(e) => setInviteRole(e.detail.selectedOption.value as SystemUserRole)}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      <Modal
        visible={roleTarget !== null}
        onDismiss={() => setRoleTarget(null)}
        header={`role を変更: ${roleTarget?.email ?? roleTarget?.username ?? ""}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setRoleTarget(null)}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={submitRoleChange}
                loading={roleSubmitting}
                disabled={roleSubmitting}
              >
                変更
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween size="m">
            {roleError && <Alert type="error">{roleError}</Alert>}
            <FormField label="新しい role">
              <Select
                selectedOption={{ value: roleNew, label: roleNew }}
                options={SYSTEM_ROLES.map((r) => ({ value: r, label: r }))}
                onChange={(e) => setRoleNew(e.detail.selectedOption.value as SystemUserRole)}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      <Modal
        visible={deleteTarget !== null}
        onDismiss={() => setDeleteTarget(null)}
        header="user を削除しますか?"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setDeleteTarget(null)}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={submitDelete}
                loading={deleteSubmitting}
                disabled={deleteSubmitting}
              >
                削除
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {deleteError && <Alert type="error">{deleteError}</Alert>}
          <Box>
            <p>
              {deleteTarget?.email ?? deleteTarget?.username} を Cognito UserPool から削除します。
              削除した user は SystemAdmin Console にサインインできなくなります。
            </p>
            <p>
              <strong>自分自身は削除できません</strong> (= lock-out 防止)。
            </p>
          </Box>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

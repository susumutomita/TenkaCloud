import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import { useApiClient } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken } from "../auth/claims";
import type { AppConfig } from "../config";
import { useLang } from "../i18n";

type Role = "Admin" | "Operator" | "Viewer";
type Status = "active" | "disabled";
interface User {
  id: string;
  username: string;
  role: Role;
  status: Status;
}

export function LocalHostUsersPage({ config }: { config: AppConfig }) {
  const api = useApiClient(config);
  const auth = useAuth();
  const lang = useLang();
  const ja = lang === "ja";
  const role = auth.tokens
    ? decodeIdToken(auth.tokens.idToken)?.["custom:organizerRole"]
    : undefined;
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [newRole, setNewRole] = useState<Role>("Viewer");
  const [editing, setEditing] = useState<User | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api || role !== "Admin") return;
    try {
      const result = await api.get<{ items: User[] }>("/host/users");
      setUsers(result.items);
      setError(undefined);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [api, role]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (role !== "Admin")
    return (
      <Alert type="error">
        {ja ? "ユーザー管理は Admin のみ利用できます。" : "Only Admin can manage organizers."}
      </Alert>
    );

  const create = async () => {
    if (!api) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/host/users", { username: name, password, role: newRole });
      setName("");
      setPassword("");
      await refresh();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!api || !editing) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`/host/users/${editing.id}`, {
        role: editing.role,
        status: editing.status,
        ...(editPassword ? { password: editPassword } : {}),
      });
      setEditing(null);
      setEditPassword("");
      await refresh();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (user: User) => {
    if (
      !api ||
      !window.confirm(ja ? `${user.username} を削除しますか？` : `Delete ${user.username}?`)
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await api.del(`/host/users/${user.id}`);
      await refresh();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h1">{ja ? "主催者ユーザー" : "Organizer users"}</Header>}>
        <SpaceBetween size="m">
          <Box color="text-body-secondary">
            {ja
              ? "Admin はユーザーと設定を管理できます。Operator は大会運営とチームキー配布、Viewer は閲覧のみです。最後の有効な Admin は変更・削除できません。"
              : "Admin manages users and settings. Operator runs events and distributes team keys. Viewer can only read. The last active Admin cannot be changed or deleted."}
          </Box>
          {error && <Alert type="error">{error}</Alert>}
          <OrganizerList
            users={users}
            busy={busy}
            ja={ja}
            onEdit={(user) => {
              setEditing(user);
              setEditPassword("");
            }}
            onRemove={remove}
          />
        </SpaceBetween>
      </Container>
      {editing && (
        <EditOrganizer
          user={editing}
          onChange={setEditing}
          password={editPassword}
          onPasswordChange={setEditPassword}
          onSave={save}
          onCancel={() => setEditing(null)}
          busy={busy}
          ja={ja}
        />
      )}
      <CreateOrganizer
        name={name}
        onNameChange={setName}
        password={password}
        onPasswordChange={setPassword}
        role={newRole}
        onRoleChange={setNewRole}
        onCreate={create}
        busy={busy}
        ja={ja}
      />
    </SpaceBetween>
  );
}

function roleFromInput(value: string): Role {
  if (value === "Admin" || value === "Operator" || value === "Viewer") return value;
  throw new Error("Unexpected organizer role option.");
}

function statusFromInput(value: string): Status {
  if (value === "active" || value === "disabled") return value;
  throw new Error("Unexpected organizer status option.");
}

function OrganizerList({
  users,
  busy,
  ja,
  onEdit,
  onRemove,
}: {
  users: readonly User[];
  busy: boolean;
  ja: boolean;
  onEdit: (user: User) => void;
  onRemove: (user: User) => void;
}) {
  return (
    <ul>
      {users.map((user) => (
        <li key={user.id} style={{ padding: "0.6rem 0", borderBottom: "1px solid #ddd" }}>
          <strong>{user.username}</strong> · {user.role} · {user.status}{" "}
          <Button disabled={busy} onClick={() => onEdit(user)}>
            {ja ? "編集" : "Edit"}
          </Button>{" "}
          <Button disabled={busy} onClick={() => onRemove(user)}>
            {ja ? "削除" : "Delete"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function EditOrganizer({
  user,
  onChange,
  password,
  onPasswordChange,
  onSave,
  onCancel,
  busy,
  ja,
}: {
  user: User;
  onChange: (user: User) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  ja: boolean;
}) {
  return (
    <Container
      header={
        <Header variant="h2">
          {ja ? "ユーザーを編集" : "Edit user"}: {user.username}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <FormField label={ja ? "権限" : "Role"}>
          <select
            aria-label={ja ? "権限" : "Role"}
            value={user.role}
            onChange={(event) => onChange({ ...user, role: roleFromInput(event.target.value) })}
          >
            <option>Admin</option>
            <option>Operator</option>
            <option>Viewer</option>
          </select>
        </FormField>
        <FormField label={ja ? "状態" : "Status"}>
          <select
            aria-label={ja ? "状態" : "Status"}
            value={user.status}
            onChange={(event) => onChange({ ...user, status: statusFromInput(event.target.value) })}
          >
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </FormField>
        <FormField label={ja ? "新しいパスワード（変更時のみ）" : "New password (only to change)"}>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={({ detail }) => onPasswordChange(detail.value)}
          />
        </FormField>
        <SpaceBetween direction="horizontal" size="s">
          <Button variant="primary" disabled={busy} onClick={onSave}>
            {ja ? "保存" : "Save"}
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            {ja ? "キャンセル" : "Cancel"}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}

function CreateOrganizer({
  name,
  onNameChange,
  password,
  onPasswordChange,
  role,
  onRoleChange,
  onCreate,
  busy,
  ja,
}: {
  name: string;
  onNameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  role: Role;
  onRoleChange: (role: Role) => void;
  onCreate: () => void;
  busy: boolean;
  ja: boolean;
}) {
  return (
    <Container header={<Header variant="h2">{ja ? "ユーザーを追加" : "Add organizer"}</Header>}>
      <SpaceBetween size="m">
        <FormField label={ja ? "ユーザー名" : "Username"}>
          <Input
            value={name}
            autoComplete="off"
            onChange={({ detail }) => onNameChange(detail.value)}
          />
        </FormField>
        <FormField label={ja ? "パスワード（12文字以上）" : "Password (at least 12 characters)"}>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={({ detail }) => onPasswordChange(detail.value)}
          />
        </FormField>
        <FormField label={ja ? "権限" : "Role"}>
          <select
            aria-label={ja ? "新しいユーザーの権限" : "New user role"}
            value={role}
            onChange={(event) => onRoleChange(roleFromInput(event.target.value))}
          >
            <option>Admin</option>
            <option>Operator</option>
            <option>Viewer</option>
          </select>
        </FormField>
        <Button
          variant="primary"
          disabled={busy || !name || password.length < 12}
          onClick={onCreate}
        >
          {ja ? "追加" : "Add"}
        </Button>
      </SpaceBetween>
    </Container>
  );
}

import "@cloudscape-design/global-styles/index.css";
import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { TokenSet } from "@tenkacloud/auth-client";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { EventListPage } from "../pages/EventList";
import { HostEventCreate } from "./HostEventCreate";
import { HostEventDetail } from "./HostEventDetail";

function HostLogin({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${config.apiBaseUrl}/host/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const value = (await response.json()) as Partial<TokenSet> & { message?: string };
      if (
        !response.ok ||
        !value.idToken ||
        !value.accessToken ||
        !value.refreshToken ||
        typeof value.expiresAt !== "number"
      )
        throw new Error(value.message ?? "主催者キーを確認してください。");
      auth.setTokens({
        idToken: value.idToken,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
      });
      setKey("");
      navigate("/events", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ログインに失敗しました。");
    } finally {
      setBusy(false);
    }
  }
  if (auth.tokens) return <Navigate to="/events" replace />;
  return (
    <div style={{ maxWidth: 560, margin: "64px auto" }}>
      <Container header={<Header variant="h1">ローカル大会の主催者ログイン</Header>}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <SpaceBetween size="l">
            <p>
              起動したターミナルに表示された主催者キーを入力してください。参加者には、イベント作成後に発行するチームキーを配布します。
            </p>
            {error && <Alert type="error">{error}</Alert>}
            <FormField label="主催者キー">
              <Input
                type="password"
                value={key}
                onChange={({ detail }) => setKey(detail.value)}
                autoComplete="off"
              />
            </FormField>
            <Button variant="primary" formAction="submit" loading={busy} disabled={!key}>
              ログイン
            </Button>
          </SpaceBetween>
        </form>
      </Container>
    </div>
  );
}

export function HostApp({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!auth.tokens) return;
    const timer = setTimeout(auth.logout, Math.max(0, auth.tokens.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [auth.tokens, auth.logout]);
  if (!auth.ready) return null;
  if (!auth.tokens) return <HostLogin config={config} />;
  return (
    <main
      style={{
        maxWidth: 1440,
        margin: "0 auto",
        padding: "24px 32px",
      }}
    >
      <SpaceBetween size="l">
        <Header
          variant="h1"
          description="主催者のPCで開催する、実データの競技環境です。個人練習モードとは別に認証・運営します。"
          actions={
            <SpaceBetween direction="horizontal" size="s">
              <Button onClick={() => navigate("/events")}>イベント一覧</Button>
              <Button onClick={auth.logout}>ログアウト</Button>
            </SpaceBetween>
          }
        >
          TenkaCloud / ローカル大会
        </Header>
        <Routes>
          <Route path="/events" element={<EventListPage config={config} />} />
          <Route path="/events/new" element={<HostEventCreate config={config} />} />
          <Route path="/events/:eventId" element={<HostEventDetail config={config} />} />
          <Route path="*" element={<Navigate to="/events" replace />} />
        </Routes>
      </SpaceBetween>
    </main>
  );
}

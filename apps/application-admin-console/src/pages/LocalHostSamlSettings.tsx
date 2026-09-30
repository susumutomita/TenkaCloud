import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import { useApiClient } from "../api/client";
import type { AppConfig } from "../config";
import { useLang } from "../i18n";

interface Provider {
  issuer: string;
  entryPoint: string;
  certificate: string;
}
interface Identity {
  id: string;
  issuer: string;
  subject: string;
  userId: string;
}
interface Settings {
  provider: Provider | null;
  entityId: string;
  callbackUrl: string;
  identities: Identity[];
}
interface Organizer {
  id: string;
  username: string;
  role: string;
}
const emptyProvider: Provider = { issuer: "", entryPoint: "", certificate: "" };

export function LocalHostSamlSettings({ config }: { config: AppConfig }) {
  const api = useApiClient(config);
  const ja = useLang() === "ja";
  const [settings, setSettings] = useState<Settings>();
  const [provider, setProvider] = useState<Provider>(emptyProvider);
  const [users, setUsers] = useState<Organizer[]>([]);
  const [userId, setUserId] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!api) return;
    const [current, organizers] = await Promise.all([
      api.get<Settings>("/host/saml/provider"),
      api.get<{ items: Organizer[] }>("/host/users"),
    ]);
    setSettings(current);
    setProvider(current.provider ?? emptyProvider);
    setUsers(organizers.items);
  }, [api]);
  useEffect(() => {
    void refresh().catch((cause) => setError(toErrorMessage(cause)));
  }, [refresh]);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Container header={<Header variant="h2">SAML</Header>}>
      <SpaceBetween size="m">
        <Box color="text-body-secondary">
          {ja
            ? "署名された SAML 応答と persistent NameID を使います。先に主催者ユーザーを作成し、NameID を明示的に紐付けてください。メールアドレスからの自動登録やロール変更は行いません。設定を保存すると SAML セッションは失効します。"
            : "Use signed SAML responses and persistent NameID. Create organizer users first, then link each NameID explicitly. Email addresses do not create users or assign roles. Saving provider settings revokes SAML sessions."}
        </Box>
        {error && <Alert type="error">{error}</Alert>}
        {settings && (
          <>
            <FormField
              label={ja ? "SP Entity ID（IdP に登録）" : "SP Entity ID (register with IdP)"}
            >
              <Input readOnly value={settings.entityId} />
            </FormField>
            <FormField label={ja ? "ACS URL（HTTP-POST）" : "ACS URL (HTTP-POST)"}>
              <Input readOnly value={settings.callbackUrl} />
            </FormField>
            <FormField label="IdP Entity ID">
              <Input
                value={provider.issuer}
                disabled={busy}
                onChange={({ detail }) => setProvider({ ...provider, issuer: detail.value })}
              />
            </FormField>
            <FormField
              label={ja ? "IdP ログイン URL（HTTP-Redirect）" : "IdP sign-in URL (HTTP-Redirect)"}
            >
              <Input
                value={provider.entryPoint}
                disabled={busy}
                onChange={({ detail }) => setProvider({ ...provider, entryPoint: detail.value })}
              />
            </FormField>
            <FormField label={ja ? "IdP 署名証明書（PEM）" : "IdP signing certificate (PEM)"}>
              <Textarea
                rows={8}
                value={provider.certificate}
                disabled={busy}
                onChange={({ detail }) => setProvider({ ...provider, certificate: detail.value })}
              />
            </FormField>
            <Button
              variant="primary"
              disabled={
                !api || busy || !provider.issuer || !provider.entryPoint || !provider.certificate
              }
              onClick={() => {
                if (api) void mutate(() => api.put("/host/saml/provider", provider));
              }}
            >
              {ja ? "IdP 設定を保存" : "Save IdP settings"}
            </Button>
            <Header variant="h3">
              {ja ? "ユーザーと NameID の紐付け" : "Organizer NameID links"}
            </Header>
            <ul>
              {settings.identities.map((identity) => (
                <li key={identity.id}>
                  <strong>
                    {users.find((user) => user.id === identity.userId)?.username ?? identity.userId}
                  </strong>{" "}
                  <span>{identity.subject}</span>
                  {" · "}
                  <span>{identity.issuer}</span>{" "}
                  <Button
                    disabled={!api || busy}
                    onClick={() => {
                      if (api)
                        void mutate(() =>
                          api.del(`/host/saml/identities/${encodeURIComponent(identity.id)}`),
                        );
                    }}
                  >
                    {ja ? "紐付け解除" : "Unlink"}
                  </Button>
                </li>
              ))}
            </ul>
            <FormField label={ja ? "既存の主催者ユーザー" : "Existing organizer"}>
              <select
                aria-label={ja ? "既存の主催者ユーザー" : "Existing organizer"}
                value={userId}
                disabled={busy}
                onChange={(event) => setUserId(event.target.value)}
              >
                <option value="">{ja ? "ユーザーを選択" : "Choose an organizer"}</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.username} ({user.role})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Persistent NameID">
              <Input
                value={subject}
                disabled={busy}
                onChange={({ detail }) => setSubject(detail.value)}
              />
            </FormField>
            <Button
              disabled={!api || busy || !settings.provider || !userId || !subject}
              onClick={() => {
                if (api) void mutate(() => api.post("/host/saml/identities", { userId, subject }));
              }}
            >
              {ja ? "NameID を紐付ける" : "Link NameID"}
            </Button>
          </>
        )}
      </SpaceBetween>
    </Container>
  );
}

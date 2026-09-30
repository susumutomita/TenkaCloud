import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Toggle from "@cloudscape-design/components/toggle";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useEffect, useState } from "react";
import { useApiClient } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken } from "../auth/claims";
import type { AppConfig } from "../config";
import { useLang } from "../i18n";
import { LocalHostSamlSettings } from "./LocalHostSamlSettings";

interface Flags {
  saml: boolean;
  audit: boolean;
}
const flagKeys = ["saml", "audit"] as const;

export function LocalHostSettingsPage({ config }: { config: AppConfig }) {
  const api = useApiClient(config);
  const auth = useAuth();
  const ja = useLang() === "ja";
  const role = auth.tokens
    ? decodeIdToken(auth.tokens.idToken)?.["custom:organizerRole"]
    : undefined;
  const [flags, setFlags] = useState<Flags>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    let active = true;
    api
      .get<{ flags: Flags }>("/feature-flags")
      .then((result) => {
        if (active) setFlags(result.flags);
      })
      .catch((cause) => {
        if (active) setError(toErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (role !== "Admin")
    return (
      <Alert type="error">
        {ja ? "設定は Admin のみ変更できます。" : "Only Admin can change settings."}
      </Alert>
    );

  const toggle = async (key: keyof Flags, enabled: boolean) => {
    if (!api) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.put<{ flags: Flags }>("/feature-flags", { key, enabled });
      setFlags(result.flags);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container
      header={<Header variant="h1">{ja ? "ローカルホスト設定" : "Local host settings"}</Header>}
    >
      <SpaceBetween size="m">
        <Box color="text-body-secondary">
          {ja
            ? "機能フラグは保存されます。SAML を有効にする前に、IdP とユーザーの NameID を設定してください。監査ログは既定で停止中です。有効にすると host のデータベースだけに記録します。停止中も保存済みの記録を閲覧できます。"
            : "Feature flags are saved. Configure the IdP and organizer NameIDs before enabling SAML. Audit logging is off by default. When enabled, records are saved only in the host database. Retained records remain readable while recording is stopped."}
        </Box>
        {error && <Alert type="error">{error}</Alert>}
        {flags &&
          flagKeys.map((key) => (
            <Toggle
              key={key}
              checked={flags[key]}
              disabled={busy}
              onChange={({ detail }) => void toggle(key, detail.checked)}
            >
              {key}
            </Toggle>
          ))}
        <LocalHostSamlSettings config={config} />
      </SpaceBetween>
    </Container>
  );
}

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useState } from "react";
import { useApiClient } from "../../api/client";
import {
  getTeamCredentialStatus,
  registerTeamCredential,
  revokeTeamCredential,
  type TeamCredentialProvider,
} from "../../api/team-credentials-client";
import { FriendlyErrorAlert } from "../../components/FriendlyErrorAlert";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { type FriendlyError, toFriendlyError } from "../../lib/friendly-error";

/**
 * [ADR-026/027/032 / Issue #1413] per-team cloud credential onboarding パネル。
 *
 * TenantAdmin が非 AWS 問題 (sakura/azure/gcp) を deploy する前に、 team の認証情報 (provider 別 JSON) を
 * `PUT /admin/team-cloud-credentials/:provider/:teamSlug` で SSM SecureString store に登録 / 失効する。
 * credential JSON の形は provider 別で backend が Zod 検証するため、 ここでは textarea で受ける
 * (= per-provider field を画面側で持たず 2 重メンテを避ける)。 secret は送るだけで status では返らない。
 */

const SLUG_RE = /^[a-z0-9-]+$/;

const PROVIDER_OPTIONS: ReadonlyArray<{ value: TeamCredentialProvider; label: string }> = [
  { value: "sakura", label: "Sakura (AppRun)" },
  { value: "azure", label: "Azure (Deployment Stacks)" },
  { value: "gcp", label: "GCP (Infrastructure Manager)" },
];

export function TeamCloudCredentialsPanel({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const t = useT();
  const [provider, setProvider] = useState<TeamCredentialProvider>("sakura");
  const [teamSlug, setTeamSlug] = useState("");
  const [credentialJson, setCredentialJson] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const slugInvalid = teamSlug.length > 0 && !SLUG_RE.test(teamSlug);
  const baseDisabled = !apiClient || inFlight || teamSlug.length === 0 || slugInvalid;
  // provider は常に PROVIDER_OPTIONS の value のいずれか (= find は必ず一致する)。
  const selectedOption = PROVIDER_OPTIONS.find((o) => o.value === provider) as {
    value: TeamCredentialProvider;
    label: string;
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setInFlight(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setInFlight(false);
    }
  };

  const handleRegister = async (): Promise<void> => {
    // button は disabled={baseDisabled} (= !apiClient 含む) なので enabled 時のみ呼ばれる (= 防御的不到達)。
    /* v8 ignore next */
    if (!apiClient) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(credentialJson) as Record<string, unknown>;
    } catch {
      setError({ title: t("team_cloud_credentials.invalid_json") });
      return;
    }
    await run(async () => {
      await registerTeamCredential(apiClient, provider, teamSlug, parsed);
      setNotice(t("team_cloud_credentials.registered"));
    });
  };

  const handleRevoke = async (): Promise<void> => {
    /* v8 ignore next */
    if (!apiClient) return;
    await run(async () => {
      await revokeTeamCredential(apiClient, provider, teamSlug);
      setNotice(t("team_cloud_credentials.revoked"));
    });
  };

  const handleCheckStatus = async (): Promise<void> => {
    /* v8 ignore next */
    if (!apiClient) return;
    await run(async () => {
      const status = await getTeamCredentialStatus(apiClient, provider, teamSlug);
      setNotice(
        status.registered
          ? t("team_cloud_credentials.status_registered")
          : t("team_cloud_credentials.status_unregistered"),
      );
    });
  };

  return (
    <Container header={<Header variant="h2">{t("team_cloud_credentials.title")}</Header>}>
      <SpaceBetween size="m">
        <Box color="text-body-secondary">{t("team_cloud_credentials.description")}</Box>
        {error && <FriendlyErrorAlert error={error} />}
        {notice && (
          <Alert type="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        <FormField label={t("team_cloud_credentials.provider_label")}>
          <Select
            selectedOption={selectedOption}
            options={PROVIDER_OPTIONS}
            disabled={inFlight}
            onChange={(e) => setProvider(e.detail.selectedOption.value as TeamCredentialProvider)}
          />
        </FormField>
        <FormField
          label={t("team_cloud_credentials.team_label")}
          description={t("team_cloud_credentials.team_description")}
          errorText={slugInvalid ? t("team_cloud_credentials.team_invalid") : undefined}
        >
          <Input
            value={teamSlug}
            onChange={(e) => setTeamSlug(e.detail.value)}
            invalid={slugInvalid}
            placeholder="team-a"
            disabled={inFlight}
          />
        </FormField>
        <FormField
          label={t("team_cloud_credentials.credential_label")}
          description={t("team_cloud_credentials.credential_description")}
        >
          <Textarea
            value={credentialJson}
            onChange={(e) => setCredentialJson(e.detail.value)}
            placeholder='{"accessToken":"...","accessTokenSecret":"..."}'
            disabled={inFlight}
            rows={5}
          />
        </FormField>
        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="primary"
            loading={inFlight}
            disabled={baseDisabled || credentialJson.length === 0}
            onClick={() => void handleRegister()}
          >
            {t("team_cloud_credentials.register_button")}
          </Button>
          <Button disabled={baseDisabled} onClick={() => void handleCheckStatus()}>
            {t("team_cloud_credentials.status_button")}
          </Button>
          <Button disabled={baseDisabled} onClick={() => void handleRevoke()}>
            {t("team_cloud_credentials.revoke_button")}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}

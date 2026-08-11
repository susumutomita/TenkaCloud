import { useCallback, useState } from "react";
import { canMutateTenant, useApiClient } from "../../api/client";
import {
  getTeamCredentialStatus,
  registerTeamCredential,
  revokeTeamCredential,
  type TeamCredentialProvider,
} from "../../api/team-credentials-client";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { type FriendlyError, toFriendlyError } from "../../lib/friendly-error";

/**
 * Issue #1413: TeamCloudCredentialsPanel の view-model hook。
 *
 * data/effect 層 (apiClient 解決・per-team 認証情報の register/revoke/status・
 * JSON parse 検証・FriendlyError 変換・notice メッセージ) をここに集約し、 panel を純粋な
 * presentation に保つ (= `useCompetitorAccounts` と同じ責務分離。 SRP / 高結合解消)。
 * secret は送るだけで status では boolean しか返らない。
 */

const SLUG_RE = /^[a-z0-9-]+$/;

export interface ProviderOption {
  readonly value: TeamCredentialProvider;
  readonly label: string;
}

export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  { value: "sakura", label: "Sakura (AppRun)" },
  { value: "azure", label: "Azure (Deployment Stacks)" },
  { value: "gcp", label: "GCP (Infrastructure Manager)" },
];

export interface UseTeamCloudCredentialsResult {
  readonly provider: TeamCredentialProvider;
  readonly providerOption: ProviderOption;
  readonly setProvider: (value: string) => void;
  readonly teamSlug: string;
  readonly setTeamSlug: (value: string) => void;
  readonly slugInvalid: boolean;
  readonly credentialJson: string;
  readonly setCredentialJson: (value: string) => void;
  readonly inFlight: boolean;
  readonly error: FriendlyError | null;
  readonly notice: string | null;
  /** apiClient あり & slug が valid & 非 inFlight (= status/revoke を許可)。 */
  readonly canSubmit: boolean;
  /** canSubmit かつ credential JSON が非空 (= register を許可)。 */
  readonly canRegister: boolean;
  readonly dismissNotice: () => void;
  readonly register: () => Promise<void>;
  readonly revoke: () => Promise<void>;
  readonly checkStatus: () => Promise<void>;
}

export function useTeamCloudCredentials(config: AppConfig): UseTeamCloudCredentialsResult {
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const t = useT();
  const [provider, setProviderState] = useState<TeamCredentialProvider>("sakura");
  const [teamSlug, setTeamSlug] = useState("");
  const [credentialJson, setCredentialJson] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const slugInvalid = teamSlug.length > 0 && !SLUG_RE.test(teamSlug);
  const canSubmit = !!apiClient && canMutate && !inFlight && teamSlug.length > 0 && !slugInvalid;
  const canRegister = canSubmit && credentialJson.length > 0;
  // provider は常に PROVIDER_OPTIONS の value のいずれか (= find は必ず一致する)。
  const providerOption = PROVIDER_OPTIONS.find((o) => o.value === provider) as ProviderOption;

  // Select の選択値は常に PROVIDER_OPTIONS 由来なので narrowing cast で受ける。
  const setProvider = useCallback(
    (value: string) => setProviderState(value as TeamCredentialProvider),
    [],
  );

  const run = useCallback(async (fn: () => Promise<void>): Promise<void> => {
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
  }, []);

  const register = useCallback(async (): Promise<void> => {
    // button は disabled={!canRegister} (= !apiClient 含む) なので enabled 時のみ呼ばれる (= 防御的不到達)。
    /* v8 ignore next */
    if (!apiClient || !canMutate) return;
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
  }, [apiClient, canMutate, credentialJson, provider, teamSlug, run, t]);

  const revoke = useCallback(async (): Promise<void> => {
    /* v8 ignore next */
    if (!apiClient || !canMutate) return;
    await run(async () => {
      await revokeTeamCredential(apiClient, provider, teamSlug);
      setNotice(t("team_cloud_credentials.revoked"));
    });
  }, [apiClient, canMutate, provider, teamSlug, run, t]);

  const checkStatus = useCallback(async (): Promise<void> => {
    /* v8 ignore next */
    if (!apiClient || !canMutate) return;
    await run(async () => {
      const status = await getTeamCredentialStatus(apiClient, provider, teamSlug);
      setNotice(
        status.registered
          ? t("team_cloud_credentials.status_registered")
          : t("team_cloud_credentials.status_unregistered"),
      );
    });
  }, [apiClient, canMutate, provider, teamSlug, run, t]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    provider,
    providerOption,
    setProvider,
    teamSlug,
    setTeamSlug,
    slugInvalid,
    credentialJson,
    setCredentialJson,
    inFlight,
    error,
    notice,
    canSubmit,
    canRegister,
    dismissNotice,
    register,
    revoke,
    checkStatus,
  };
}

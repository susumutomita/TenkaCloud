import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useEffect, useState } from "react";
import {
  type CliCredentialsView,
  getCliCredentials,
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../api/portal-client";
import { useT } from "../i18n";
import { toErrorMessage } from "../lib/error-message";

/**
 * Issue #1197: CLI / SDK 用一時資格情報を取得して表示する 1 problem 単位の panel。
 *
 * UX 方針:
 *   - credentials は localStorage / sessionStorage に **persist しない** (= state のみ)
 *   - 切替ボタンで mask / reveal を制御 (default は mask)
 *   - shell export snippet を生成、 コピー操作で clipboard へ
 *   - 残り TTL を 1 秒ごとに再評価して「あと N 分 N 秒」 を表示
 *   - 取得失敗時は stage / reason を可視化 (= AssumeRole で どちらの段が落ちたか)
 */
export function CliCredentialsPanel({
  apiBaseUrl,
  sessionToken,
  jobId,
  onAuthError,
  mockBlocked = false,
}: {
  readonly apiBaseUrl: string;
  readonly sessionToken: string;
  readonly jobId: string;
  readonly onAuthError: () => void;
  /**
   * dev-mock mode 等で backend に到達できない時に true。 「資格情報を発行」 ボタンの
   * 代わりに「モックモードでは発行できません」 info を出して赤い error を回避する。
   */
  readonly mockBlocked?: boolean;
}) {
  const t = useT();
  const [credentials, setCredentials] = useState<CliCredentialsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const fetchCredentials = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const view = await getCliCredentials(apiBaseUrl, sessionToken, jobId);
      setCredentials(view);
      setRevealed(false);
    } catch (err) {
      if (err instanceof PortalAuthError) {
        onAuthError();
        return;
      }
      if (err instanceof PortalAssumeRoleError) {
        setError(
          t("sso_credentials.cli.assume_role_failed", {
            stage: t(`sso_credentials.cli.stage_${err.stage}`),
            reason: err.reason,
          }),
        );
        return;
      }
      if (err instanceof PortalValidationError) {
        setError(t("sso_credentials.validation_error", { errorCode: err.errorCode }));
        return;
      }
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const clearCredentials = (): void => {
    setCredentials(null);
    setRevealed(false);
    setError(null);
  };

  return (
    <ExpandableSection variant="footer" headerText={t("sso_credentials.cli.section_header")}>
      <SpaceBetween size="s">
        <Box variant="small" color="text-body-secondary">
          {t("sso_credentials.cli.body")}
        </Box>
        {error && (
          <Alert
            type="error"
            header={t("sso_credentials.cli.error_header")}
            dismissible
            onDismiss={() => setError(null)}
          >
            {error}
          </Alert>
        )}
        {mockBlocked && (
          <Alert type="info" header={t("sso_credentials.cli.mock_blocked_header")}>
            {t("sso_credentials.cli.mock_blocked_body")}
          </Alert>
        )}
        {!credentials && !mockBlocked && (
          <Button
            variant="normal"
            iconName="key"
            loading={loading}
            disabled={loading}
            onClick={() => void fetchCredentials()}
          >
            {t("sso_credentials.cli.issue_button")}
          </Button>
        )}
        {credentials && (
          <CliCredentialsDisplay
            credentials={credentials}
            revealed={revealed}
            onToggleReveal={() => setRevealed((v) => !v)}
            onClear={clearCredentials}
            onReissue={() => void fetchCredentials()}
            reissuing={loading}
          />
        )}
      </SpaceBetween>
    </ExpandableSection>
  );
}

/**
 * 取得済み credentials の display。 mask / reveal / copy / 残り TTL countdown を担当。
 */
function CliCredentialsDisplay({
  credentials,
  revealed,
  onToggleReveal,
  onClear,
  onReissue,
  reissuing,
}: {
  readonly credentials: CliCredentialsView;
  readonly revealed: boolean;
  readonly onToggleReveal: () => void;
  readonly onClear: () => void;
  readonly onReissue: () => void;
  readonly reissuing: boolean;
}) {
  const t = useT();
  const remaining = useCountdown(credentials.expiration);

  const exportSnippet = buildShellExport(credentials);
  const expired = remaining.kind === "expired";

  return (
    <SpaceBetween size="s">
      <Box variant="small" color={expired ? "text-status-error" : "text-status-info"}>
        {expired
          ? t("sso_credentials.cli.expired_note")
          : t("sso_credentials.cli.ttl_remaining", { remaining: remaining.label })}
      </Box>
      {expired && (
        <StatusIndicator type="error">{t("sso_credentials.cli.expired_status")}</StatusIndicator>
      )}
      <CredentialField
        label={t("sso_credentials.cli.field_access_key_id")}
        value={credentials.accessKeyId}
        revealed
      />
      <CredentialField
        label={t("sso_credentials.cli.field_secret_access_key")}
        value={credentials.secretAccessKey}
        revealed={revealed}
      />
      <CredentialField
        label={t("sso_credentials.cli.field_session_token")}
        value={credentials.sessionToken}
        revealed={revealed}
      />
      <CredentialField label="AWS_REGION" value={credentials.region} revealed />
      <SpaceBetween size="xs" direction="horizontal">
        <Button
          variant="normal"
          iconName="copy"
          onClick={() => void writeToClipboard(exportSnippet)}
        >
          {t("sso_credentials.cli.copy_export_button")}
        </Button>
        <Button variant="normal" onClick={onToggleReveal}>
          {revealed
            ? t("sso_credentials.cli.hide_secrets_button")
            : t("sso_credentials.cli.reveal_secrets_button")}
        </Button>
        <Button variant="normal" loading={reissuing} onClick={onReissue}>
          {t("sso_credentials.cli.reissue_button")}
        </Button>
        <Button variant="link" onClick={onClear}>
          {t("sso_credentials.cli.clear_button")}
        </Button>
      </SpaceBetween>
      <Box variant="small" color="text-body-secondary">
        {t("sso_credentials.cli.security_note")}
      </Box>
    </SpaceBetween>
  );
}

function CredentialField({
  label,
  value,
  revealed,
}: {
  readonly label: string;
  readonly value: string;
  readonly revealed: boolean;
}) {
  const display = revealed ? value : mask(value);
  return (
    <Box>
      <Box variant="awsui-key-label">{label}</Box>
      <SpaceBetween size="xxs" direction="horizontal">
        <code
          style={{
            display: "inline-block",
            fontSize: 12,
            padding: "4px 8px",
            background: "#f3f4f6",
            borderRadius: 4,
            wordBreak: "break-all",
            maxWidth: 520,
          }}
        >
          {display}
        </code>
        <Button
          variant="inline-icon"
          iconName="copy"
          ariaLabel={`Copy ${label}`}
          onClick={() => void writeToClipboard(value)}
        />
      </SpaceBetween>
    </Box>
  );
}

function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(0, value.length - 8))}${value.slice(-4)}`;
}

export function buildShellExport(credentials: CliCredentialsView): string {
  return [
    `export AWS_ACCESS_KEY_ID=${credentials.accessKeyId}`,
    `export AWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`,
    `export AWS_SESSION_TOKEN=${credentials.sessionToken}`,
    `export AWS_REGION=${credentials.region}`,
  ].join("\n");
}

async function writeToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API unavailable (= older browsers / non-https): silent fail.
    // 真の解決策は UI で text を select + copy 案内するが、 POC 範囲では log のみ。
    console.warn("[cli] navigator.clipboard.writeText failed");
  }
}

type CountdownState =
  | { readonly kind: "remaining"; readonly label: string }
  | { readonly kind: "expired" };

/**
 * `expiration` (= ISO 8601) と 現在時刻 の差を 1 秒粒度で表示用 label に変換する。
 * exported for unit-test 用途。
 */
export function describeRemainingTime(expirationIso: string, nowMs: number): CountdownState {
  const expiresAt = Date.parse(expirationIso);
  if (!Number.isFinite(expiresAt)) return { kind: "expired" };
  const diffMs = expiresAt - nowMs;
  if (diffMs <= 0) return { kind: "expired" };
  const totalSec = Math.floor(diffMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return { kind: "remaining", label: `${min}m ${sec.toString().padStart(2, "0")}s` };
}

function useCountdown(expirationIso: string): CountdownState {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return describeRemainingTime(expirationIso, now);
}

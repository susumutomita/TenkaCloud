import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Multiselect from "@cloudscape-design/components/multiselect";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../../api/client";
import type { EventDetail } from "../../api/events-client";
import { type AppConfig, isLocalHost } from "../../config";
import { useT } from "../../i18n";

interface RegistrationSummary {
  tenantId: string;
  enabled: boolean;
  featureEnabled?: boolean;
  canConfigure?: boolean;
  closesAt?: string;
  capacity: number;
  claimed: number;
  claimedTeamIds: string[];
  teamIds: string[];
  invitation?: string;
}

export function buildRegistrationLink(
  base: string,
  tenantId: string,
  eventId: string,
  invitation: string,
) {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  url.pathname += `join/${encodeURIComponent(tenantId)}/${encodeURIComponent(eventId)}`;
  url.search = "";
  url.hash = new URLSearchParams({ invite: invitation }).toString();
  return url.toString();
}

function localDateTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function EventRegistrationPanel({
  apiClient,
  config,
  detail,
  canMutateTenant,
}: {
  apiClient: ApiClient | null;
  config: AppConfig;
  detail: EventDetail;
  canMutateTenant: boolean;
}) {
  const t = useT();
  const localHost = isLocalHost(config);
  const [summary, setSummary] = useState<RegistrationSummary | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [closesAt, setClosesAt] = useState(() =>
    localDateTime(detail.endsAt ?? new Date(Date.now() + 86400000).toISOString()),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const path = `/events/${detail.eventId}/registration`;
  const pending = useRef<AbortController | null>(null);
  const showError = useCallback(
    (cause: unknown) => {
      let code = "unavailable";
      if (cause instanceof ApiError) {
        try {
          const body: unknown = JSON.parse(cause.message.replace(/^API \d+: /, ""));
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string")
            code = body.error;
        } catch {
          /* Network responses may not contain JSON. */
        }
      }
      const known = [
        "invalid_pool",
        "not_ready",
        "closed",
        "conflict",
        "login_key_missing",
        "feature_disabled",
        "forbidden",
      ];
      const suffix = known.includes(code) ? code : "unavailable";
      const hostError =
        localHost && ["invalid_pool", "not_ready", "login_key_missing"].includes(suffix);
      setError(t(`registration.${hostError ? "host_" : ""}error_${suffix}`));
    },
    [t, localHost],
  );

  const { busy, runMutation } = useRegistrationMutation(showError);

  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    if (!apiClient || config.mode === "demo") return;
    void apiClient
      .get<RegistrationSummary>(path)
      .then((value) => {
        if (request.signal.aborted) return;
        setError("");
        setSummary(value);
        setLink("");
        setCopied(false);
        setTeamIds(value.teamIds);
        if (value.closesAt) setClosesAt(localDateTime(value.closesAt));
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted) showError(cause);
      });
  }, [apiClient, config.mode, path, showError]);

  useEffect(() => {
    refresh();
    return () => {
      pending.current?.abort();
    };
  }, [refresh]);

  async function save(enabled: boolean) {
    if (!apiClient || busy) return;
    if (enabled && !config.participantPortalUrl) return;
    setError("");
    setCopied(false);
    await runMutation(async (signal) => {
      const response = await apiClient.put<RegistrationSummary>(
        path,
        enabled
          ? {
              enabled,
              teamIds,
              closesAt: new Date(closesAt).toISOString(),
            }
          : { enabled },
      );
      if (signal.aborted) return;
      // The invitation is returned only by this PUT. A refresh GET still in flight would land
      // afterwards, clear the one-time link and restore the older summary, leaving the operator
      // no way to recover the link short of reissuing (and so revoking) it again. Supersede it
      // only on success: after a failed PUT that GET is still the best state to show.
      pending.current?.abort();
      setSummary(response);
      setLink(invitationLink(config.participantPortalUrl, detail.eventId, response));
    });
  }

  async function toggleFeature() {
    if (!apiClient || busy) return;
    setError("");
    await runMutation(async (signal) => {
      await apiClient.put("/feature-flags", {
        key: "registration",
        enabled: !summary?.featureEnabled,
      });
      if (!signal.aborted) refresh();
    });
  }

  const canSave = registrationPermission(summary, localHost, canMutateTenant);
  if (config.mode === "demo") return null;
  const options = detail.teams.map((team) => ({
    label: team.displayName ?? team.internalSlug,
    value: team.teamId,
    description: summary?.claimedTeamIds?.includes(team.teamId)
      ? t("registration.allocated")
      : t("registration.unallocated"),
  }));
  return (
    <Container header={<Header variant="h2">{t("registration.title")}</Header>}>
      <SpaceBetween size="m">
        <p>{t(localHost ? "registration.host_description" : "registration.description")}</p>
        {localHost && (
          <RegistrationFeature summary={summary} busy={busy} toggle={() => void toggleFeature()} />
        )}
        <Button disabled={busy} onClick={refresh}>
          {t("registration.refresh")}
        </Button>
        {error && <Alert type="error">{error}</Alert>}
        {summary && (
          <p>
            {t(summary.enabled ? "registration.open" : "registration.closed", {
              claimed: summary.claimed,
              capacity: summary.capacity,
            })}
          </p>
        )}
        <FormField label={t("registration.teams")} description={t("registration.teams_help")}>
          <Multiselect
            options={options}
            selectedOptions={options.filter((option) => teamIds.includes(option.value))}
            onChange={({ detail: change }) =>
              setTeamIds(
                change.selectedOptions.flatMap((option) => (option.value ? [option.value] : [])),
              )
            }
            disabled={!canSave || busy}
            placeholder={t("registration.select")}
          />
        </FormField>
        <FormField label={t("registration.deadline")} controlId="registration-deadline">
          <input
            id="registration-deadline"
            type="datetime-local"
            value={closesAt}
            disabled={!canSave || busy}
            onChange={(event) => setClosesAt(event.target.value)}
          />
        </FormField>
        <Checkbox
          checked={confirmed}
          disabled={!canSave || busy}
          onChange={({ detail: change }) => setConfirmed(change.checked)}
        >
          {t(localHost ? "registration.host_confirm" : "registration.confirm")}
        </Checkbox>
        <SpaceBetween direction="horizontal" size="s">
          <Button
            variant="primary"
            loading={busy}
            disabled={
              !canSave || !confirmed || !teamIds.length || !closesAt || !config.participantPortalUrl
            }
            onClick={() => void save(true)}
          >
            {t(summary?.enabled ? "registration.reissue" : "registration.open_button")}
          </Button>
          <Button disabled={!canSave || !summary?.enabled || busy} onClick={() => void save(false)}>
            {t("registration.close_button")}
          </Button>
        </SpaceBetween>
        {link && (
          <FormField label={t("registration.link")} description={t("registration.link_help")}>
            <SpaceBetween size="s">
              <input
                aria-label={t("registration.link")}
                type="text"
                value={link}
                readOnly
                style={{ width: "100%", boxSizing: "border-box", padding: "10px" }}
              />
              <Button
                iconName="copy"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(link)
                    .then(() => setCopied(true))
                    .catch(() => setError(t("registration.copy_failed")));
                }}
              >
                {t(copied ? "registration.copied" : "registration.copy")}
              </Button>
            </SpaceBetween>
          </FormField>
        )}
      </SpaceBetween>
    </Container>
  );
}

function invitationLink(
  base: string | undefined,
  eventId: string,
  response: RegistrationSummary,
): string {
  return response.invitation && base
    ? buildRegistrationLink(base, response.tenantId, eventId, response.invitation)
    : "";
}

function RegistrationFeature({
  summary,
  busy,
  toggle,
}: {
  summary: RegistrationSummary | null;
  busy: boolean;
  toggle: () => void;
}) {
  const t = useT();
  if (!summary) return null;
  return (
    <SpaceBetween size="s">
      <p>{t(summary.featureEnabled ? "registration.feature_on" : "registration.feature_off")}</p>
      <Button disabled={!summary.canConfigure || busy} onClick={toggle}>
        {t(summary.featureEnabled ? "registration.disable_feature" : "registration.enable_feature")}
      </Button>
    </SpaceBetween>
  );
}

function registrationPermission(
  summary: RegistrationSummary | null,
  localHost: boolean,
  canMutateTenant: boolean,
): boolean {
  return localHost
    ? summary?.canConfigure === true && summary.featureEnabled === true
    : canMutateTenant;
}

function useRegistrationMutation(showError: (cause: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function runMutation(operation: (signal: AbortSignal) => Promise<void>) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    try {
      await operation(request.signal);
    } catch (cause) {
      if (!request.signal.aborted) showError(cause);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return { busy, runMutation };
}

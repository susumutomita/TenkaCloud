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
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";

interface RegistrationSummary {
  tenantId: string;
  enabled: boolean;
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
  const [summary, setSummary] = useState<RegistrationSummary | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [closesAt, setClosesAt] = useState(() =>
    localDateTime(detail.endsAt ?? new Date(Date.now() + 86400000).toISOString()),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
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
      const known = ["invalid_pool", "not_ready", "closed", "conflict", "login_key_missing"];
      setError(t(`registration.error_${known.includes(code) ? code : "unavailable"}`));
    },
    [t],
  );

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
    return () => pending.current?.abort();
  }, [refresh]);

  async function save(enabled: boolean) {
    if (!apiClient || (enabled && !config.participantPortalUrl) || busy) return;
    // The invitation is returned only by this PUT. A refresh GET still in flight would land
    // afterwards, clear the one-time link and restore the older summary, leaving the operator
    // no way to recover the link short of reissuing (and so revoking) it again.
    pending.current?.abort();
    setBusy(true);
    setError("");
    setCopied(false);
    try {
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
      setSummary(response);
      setLink(
        response.invitation && config.participantPortalUrl
          ? buildRegistrationLink(
              config.participantPortalUrl,
              response.tenantId,
              detail.eventId,
              response.invitation,
            )
          : "",
      );
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  }

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
        <p>{t("registration.description")}</p>
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
            disabled={!canMutateTenant || busy}
            placeholder={t("registration.select")}
          />
        </FormField>
        <FormField label={t("registration.deadline")} controlId="registration-deadline">
          <input
            id="registration-deadline"
            type="datetime-local"
            value={closesAt}
            disabled={!canMutateTenant || busy}
            onChange={(event) => setClosesAt(event.target.value)}
          />
        </FormField>
        <Checkbox
          checked={confirmed}
          disabled={!canMutateTenant || busy}
          onChange={({ detail: change }) => setConfirmed(change.checked)}
        >
          {t("registration.confirm")}
        </Checkbox>
        <SpaceBetween direction="horizontal" size="s">
          <Button
            variant="primary"
            loading={busy}
            disabled={
              !canMutateTenant ||
              !confirmed ||
              !teamIds.length ||
              !closesAt ||
              !config.participantPortalUrl
            }
            onClick={() => void save(true)}
          >
            {t(summary?.enabled ? "registration.reissue" : "registration.open_button")}
          </Button>
          <Button
            disabled={!canMutateTenant || !summary?.enabled || busy}
            onClick={() => void save(false)}
          >
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

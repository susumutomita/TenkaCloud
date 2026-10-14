import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { CompetitionNetworkView } from "@tenkacloud/portal-contracts";
import { useCallback, useEffect, useState } from "react";
import { getCompetitionNetwork, publishCompetitionService } from "../api/portal-client";
import { useT } from "../i18n";

/** Service IDs come from the authenticated host catalog; no address, command or route input. */
function ActiveCompetitionNetworkPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  enabled?: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<CompetitionNetworkView>();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string>();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setView(await getCompetitionNetwork(apiBaseUrl, sessionToken, problemId, signal));
        setError(false);
      } catch {
        if (!signal?.aborted) setError(true);
      }
    },
    [apiBaseUrl, sessionToken, problemId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const change = async (serviceId: string, published: boolean) => {
    setPending(serviceId);
    try {
      setView(
        await publishCompetitionService(apiBaseUrl, sessionToken, problemId, serviceId, published),
      );
      setError(false);
    } catch {
      setError(true);
    } finally {
      setPending(undefined);
    }
  };
  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={
            <Button onClick={() => void refresh()} disabled={Boolean(pending)}>
              {t("problem_panel.network_refresh")}
            </Button>
          }
        >
          {t("problem_panel.network_header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Box>{t("problem_panel.network_description")}</Box>
        {error && <Alert type="error">{t("problem_panel.network_error")}</Alert>}
        {view?.declared.map((service) => (
          <SpaceBetween key={service.id} size="xs" direction="horizontal">
            <Box>{service.purpose}</Box>
            <Button
              disabled={Boolean(pending)}
              loading={pending === service.id}
              onClick={() => void change(service.id, !service.published)}
            >
              {t(
                service.published
                  ? "problem_panel.network_withdraw"
                  : "problem_panel.network_publish",
              )}
            </Button>
          </SpaceBetween>
        ))}
        {view && !view.declared.length && <Box>{t("problem_panel.network_no_declarations")}</Box>}
        <Box>{t("problem_panel.network_terminal_hint")}</Box>
        {view?.shared.map((service) => (
          <div key={`${service.teamId}/${service.problemId}/${service.serviceId}`}>
            <Box>
              {service.teamId}: {service.purpose}
            </Box>
            {service.addresses.map((address) => (
              <div key={address}>
                <code>
                  {address.includes(":") ? `[${address}]` : address}:{service.port}
                </code>
              </div>
            ))}
          </div>
        ))}
        {view && !view.shared.length && <Box>{t("problem_panel.network_no_publications")}</Box>}
      </SpaceBetween>
    </Container>
  );
}

export function CompetitionNetworkPanel(
  props: Parameters<typeof ActiveCompetitionNetworkPanel>[0],
) {
  return props.enabled ? (
    <ActiveCompetitionNetworkPanel
      key={JSON.stringify([props.apiBaseUrl, props.problemId, props.sessionToken])}
      {...props}
    />
  ) : null;
}

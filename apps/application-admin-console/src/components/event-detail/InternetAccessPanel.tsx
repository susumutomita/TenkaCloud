import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  approveInternetAccess,
  fetchInternetAccess,
  type InternetAccessView,
  revokeInternetAccess,
} from "../../api/internet-access-client";
import { useLang } from "../../i18n";
import { formatDateTime } from "../../lib/format";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function InternetAccessPanel({
  apiClient,
  eventId,
  canMutateTenant,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly eventId: string;
  readonly canMutateTenant: boolean;
  readonly t: Translate;
}) {
  const lang = useLang() === "en" ? "en" : "ja";
  const [view, setView] = useState<InternetAccessView | null>(null);
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useCallback((value: InternetAccessView, savedProblem?: string) => {
    setView(value);
    setSelected((current) =>
      Object.fromEntries(
        value.problems.map((problem) => [
          problem.problemId,
          savedProblem && problem.problemId !== savedProblem
            ? (current[problem.problemId] ?? problem.grant?.requestIds ?? [])
            : (problem.grant?.requestIds ?? []),
        ]),
      ),
    );
  }, []);
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    if (apiClient)
      fetchInternetAccess(apiClient, eventId)
        .then((value) => {
          if (!cancelled) loaded(value);
        })
        .catch((err) => {
          if (!cancelled) setError(toErrorMessage(err));
        });
    return () => {
      cancelled = true;
    };
  }, [apiClient, eventId, loaded]);
  async function save(problemId: string, revoke: boolean) {
    if (!apiClient) return;
    setBusy(true);
    setError(null);
    try {
      if (revoke) await revokeInternetAccess(apiClient, eventId, problemId);
      else await approveInternetAccess(apiClient, eventId, problemId, selected[problemId] ?? []);
      loaded(await fetchInternetAccess(apiClient, eventId), problemId);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  function selectRequest(problemId: string, requestId: string, checked: boolean) {
    setSelected((current) => ({
      ...current,
      [problemId]: checked
        ? [...(current[problemId] ?? []), requestId]
        : (current[problemId] ?? []).filter((id) => id !== requestId),
    }));
  }
  if (!error && (!view || view.problems.length === 0)) return null;
  return (
    <Container
      header={
        <Header variant="h2" description={t("event_detail.internet_description")}>
          {t("event_detail.internet_title")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error && <Alert type="error">{error}</Alert>}
        {view && !view.available && (
          <Alert type="warning" header={t("event_detail.internet_unavailable")}>
            <p>{t("event_detail.internet_unavailable_body")}</p>
            {view.reason && <Box color="text-body-secondary">{view.reason}</Box>}
          </Alert>
        )}
        {view?.problems.map((problem) => (
          <Container key={problem.problemId} header={<Header variant="h3">{problem.name}</Header>}>
            <SpaceBetween size="s">
              {problem.requests.map((request) => (
                <Checkbox
                  key={request.id}
                  checked={(selected[problem.problemId] ?? []).includes(request.id)}
                  disabled={!canMutateTenant || !view.available || busy}
                  onChange={({ detail }) =>
                    selectRequest(problem.problemId, request.id, detail.checked)
                  }
                >
                  {request.service} → {request.address}:{request.port} (TCP) — {request.purpose}
                </Checkbox>
              ))}
              {problem.grant && (
                <p>
                  {t("event_detail.internet_granted", {
                    time: formatDateTime(problem.grant.grantedAt, lang),
                  })}
                </p>
              )}
              <SpaceBetween direction="horizontal" size="s">
                <Button
                  disabled={
                    !canMutateTenant ||
                    !view.available ||
                    busy ||
                    !selected[problem.problemId]?.length
                  }
                  onClick={() => void save(problem.problemId, false)}
                >
                  {t("event_detail.internet_approve")}
                </Button>
                <Button
                  disabled={!canMutateTenant || !problem.grant || busy}
                  onClick={() => void save(problem.problemId, true)}
                >
                  {t("event_detail.internet_revoke")}
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          </Container>
        ))}
      </SpaceBetween>
    </Container>
  );
}

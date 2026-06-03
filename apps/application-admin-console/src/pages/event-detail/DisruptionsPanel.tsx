import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import Multiselect from "@cloudscape-design/components/multiselect";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type DisruptionAuditRow,
  type DisruptionCatalogEntry,
  type DisruptionScope,
  fetchDisruptionAudit,
  fetchDisruptionCatalog,
  fireDisruption,
  newFireRequestId,
} from "../../api/disruptions-client";
import type { TeamSummary } from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const SCOPE_OPTIONS: readonly DisruptionScope[] = ["all", "team", "random-n"];
const AUDIT_LIMIT = 20;

interface FireTarget {
  readonly problemId: string;
  readonly item: DisruptionCatalogEntry["disruption"];
}

/**
 * [#1417 / #1666] Operator red-team console. Lists the event's declared disruptions (catalog) and
 * lets the operator fire one at a scope (all / team / random-n); shows the fire audit log. Generic
 * — driven entirely by the catalog, so any Battle's declared disruptions appear here. Fires with
 * the disruption's declared default parameters (per-parameter editing is a follow-up). Feature-
 * flagged (`redTeam`) because the cross-account executor is not yet verified live on AWS.
 */
export function DisruptionsPanel({
  apiClient,
  eventId,
  teams,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly eventId: string;
  readonly teams: readonly TeamSummary[];
  readonly t: Translate;
}) {
  const [catalog, setCatalog] = useState<readonly DisruptionCatalogEntry[] | null>(null);
  const [audit, setAudit] = useState<readonly DisruptionAuditRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fireTarget, setFireTarget] = useState<FireTarget | null>(null);
  const [scope, setScope] = useState<DisruptionScope>("all");
  const [selectedTeamIds, setSelectedTeamIds] = useState<readonly string[]>([]);
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  const [lastFired, setLastFired] = useState<string | null>(null);

  const reloadAudit = useCallback(async () => {
    // Only called from confirmFire, which already guarded apiClient — defensive, unreachable.
    /* v8 ignore next */
    if (!apiClient) return;
    const res = await fetchDisruptionAudit(apiClient, eventId, { limit: AUDIT_LIMIT });
    setAudit(res.items);
  }, [apiClient, eventId]);

  useEffect(() => {
    if (!apiClient) return;
    setLoadError(null);
    Promise.all([
      fetchDisruptionCatalog(apiClient, eventId),
      fetchDisruptionAudit(apiClient, eventId, { limit: AUDIT_LIMIT }),
    ])
      .then(([cat, aud]) => {
        setCatalog(cat.entries);
        setAudit(aud.items);
      })
      .catch((err) => setLoadError(toErrorMessage(err)));
  }, [apiClient, eventId]);

  const teamOptions = useMemo(
    () => teams.map((tm) => ({ value: tm.teamId, label: tm.displayName || tm.internalSlug })),
    [teams],
  );

  const openFire = (target: FireTarget) => {
    setFireTarget(target);
    setScope("all");
    setSelectedTeamIds([]);
    setFireError(null);
  };

  const confirmFire = useCallback(async () => {
    // The confirm button only renders inside the modal (fireTarget set), and the catalog/Fire
    // buttons only render when apiClient is present — so this guard is defensive, unreachable.
    /* v8 ignore next */
    if (!apiClient || !fireTarget) return;
    setFiring(true);
    setFireError(null);
    try {
      const result = await fireDisruption(apiClient, eventId, {
        problemId: fireTarget.problemId,
        disruptionId: fireTarget.item.id,
        scope,
        ...(scope === "team" ? { targetTeamIds: selectedTeamIds } : {}),
        ...(scope === "random-n" ? { randomCount: Math.max(selectedTeamIds.length, 1) } : {}),
        ...(fireTarget.item.parameters ? { parameters: fireTarget.item.parameters } : {}),
        requestId: newFireRequestId(),
      });
      setLastFired(
        t("disruptions.fired_flash", {
          name: fireTarget.item.name,
          count: result.affectedTeamIds.length,
        }),
      );
      setFireTarget(null);
      await reloadAudit();
    } catch (err) {
      setFireError(toErrorMessage(err));
    } finally {
      setFiring(false);
    }
  }, [apiClient, eventId, fireTarget, scope, selectedTeamIds, reloadAudit, t]);

  const fireDisabled = firing || (scope === "team" && selectedTeamIds.length === 0);

  return (
    <Container
      header={
        <Header variant="h2" description={t("disruptions.description")}>
          {t("disruptions.header")}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Alert type="warning">{t("disruptions.experimental_banner")}</Alert>
        {loadError ? <Alert type="error">{loadError}</Alert> : null}
        {lastFired ? (
          <Alert type="success" dismissible onDismiss={() => setLastFired(null)}>
            {lastFired}
          </Alert>
        ) : null}

        <Table
          variant="embedded"
          columnDefinitions={[
            {
              id: "name",
              header: t("disruptions.col_name"),
              cell: (e: DisruptionCatalogEntry) => e.disruption.name,
            },
            {
              id: "problem",
              header: t("disruptions.col_problem"),
              cell: (e: DisruptionCatalogEntry) => e.problemId,
            },
            {
              id: "description",
              header: t("disruptions.col_description"),
              cell: (e: DisruptionCatalogEntry) => e.disruption.description,
            },
            {
              id: "fire",
              header: "",
              cell: (e: DisruptionCatalogEntry) => (
                <Button
                  variant="inline-link"
                  onClick={() => openFire({ problemId: e.problemId, item: e.disruption })}
                >
                  {t("disruptions.fire_button")}
                </Button>
              ),
            },
          ]}
          items={catalog ?? []}
          loading={catalog === null && !loadError}
          loadingText={t("disruptions.loading")}
          empty={<Box textAlign="center">{t("disruptions.catalog_empty")}</Box>}
        />

        <Header variant="h3">{t("disruptions.audit_header")}</Header>
        <Table
          variant="embedded"
          columnDefinitions={[
            {
              id: "firedAt",
              header: t("disruptions.col_fired_at"),
              cell: (r: DisruptionAuditRow) => r.firedAt,
            },
            {
              id: "disruptionId",
              header: t("disruptions.col_name"),
              cell: (r: DisruptionAuditRow) => r.disruptionId,
            },
            {
              id: "scope",
              header: t("disruptions.col_scope"),
              cell: (r: DisruptionAuditRow) => r.scope,
            },
            {
              id: "affected",
              header: t("disruptions.col_affected"),
              cell: (r: DisruptionAuditRow) => String(r.targetTeamIds.length),
            },
          ]}
          items={audit}
          empty={<Box textAlign="center">{t("disruptions.audit_empty")}</Box>}
        />
      </SpaceBetween>

      {fireTarget ? (
        <Modal
          visible
          onDismiss={() => setFireTarget(null)}
          header={t("disruptions.fire_modal_header", { name: fireTarget.item.name })}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => setFireTarget(null)} disabled={firing}>
                  {t("disruptions.cancel")}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void confirmFire()}
                  loading={firing}
                  disabled={fireDisabled}
                >
                  {t("disruptions.confirm_fire")}
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            {fireError ? <Alert type="error">{fireError}</Alert> : null}
            <Box color="text-body-secondary">{fireTarget.item.description}</Box>
            <FormField
              label={t("disruptions.scope_label")}
              description={t("disruptions.scope_description")}
            >
              <Select
                selectedOption={{ value: scope, label: t(`disruptions.scope_${scope}`) }}
                options={SCOPE_OPTIONS.map((s) => ({
                  value: s,
                  label: t(`disruptions.scope_${s}`),
                }))}
                onChange={(e) => setScope(e.detail.selectedOption.value as DisruptionScope)}
              />
            </FormField>
            {scope === "team" ? (
              <FormField label={t("disruptions.teams_label")}>
                <Multiselect
                  selectedOptions={teamOptions.filter((o) => selectedTeamIds.includes(o.value))}
                  options={teamOptions}
                  onChange={(e) =>
                    setSelectedTeamIds(e.detail.selectedOptions.map((o) => o.value as string))
                  }
                  placeholder={t("disruptions.teams_placeholder")}
                />
              </FormField>
            ) : null}
            {scope === "random-n" ? (
              <FormField
                label={t("disruptions.random_label")}
                description={t("disruptions.random_description")}
              >
                <Multiselect
                  selectedOptions={teamOptions.filter((o) => selectedTeamIds.includes(o.value))}
                  options={teamOptions}
                  onChange={(e) =>
                    setSelectedTeamIds(e.detail.selectedOptions.map((o) => o.value as string))
                  }
                  placeholder={t("disruptions.teams_placeholder")}
                />
              </FormField>
            ) : null}
          </SpaceBetween>
        </Modal>
      ) : null}
    </Container>
  );
}

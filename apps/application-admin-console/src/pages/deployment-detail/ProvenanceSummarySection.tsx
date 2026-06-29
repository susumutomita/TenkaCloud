import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import type { DeploymentSummary } from "../../api/deploy-client";
import type { TFn } from "./types";

/**
 * [Problem Packs / Issue #2096] Compact pack provenance summary on the
 * deployment-detail page. Renders the immutable pack id / version / content
 * digest / catalog snapshot id for a PACK-SOURCED deployment, and renders NOTHING
 * for a core (non-pack) problem — the whole section is hidden so core deployments
 * keep their existing UI. The values come from the backend, which resolves them
 * from the event-pinned snapshot; no local path / source credential is ever
 * present in `provenance`.
 */
export function ProvenanceSummarySection({
  deployment,
  t,
}: {
  readonly deployment: DeploymentSummary;
  readonly t: TFn;
}) {
  const provenance = deployment.provenance;
  if (!provenance) return null;
  return (
    <Container
      header={
        <Header variant="h2" description={t("deployment_detail.provenance_description")}>
          {t("deployment_detail.provenance_header")}
        </Header>
      }
    >
      <KeyValuePairs
        columns={2}
        items={[
          { label: t("deployment_detail.label_pack_id"), value: <code>{provenance.packId}</code> },
          {
            label: t("deployment_detail.label_pack_version"),
            value: <code>{provenance.packVersion}</code>,
          },
          {
            label: t("deployment_detail.label_content_digest"),
            value: <code>{provenance.contentDigest}</code>,
          },
          {
            label: t("deployment_detail.label_catalog_snapshot_id"),
            value: <code>{provenance.catalogSnapshotId}</code>,
          },
        ]}
      />
    </Container>
  );
}

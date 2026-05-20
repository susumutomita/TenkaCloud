import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import type { EventDetail } from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventTeamsPanel({
  detail,
  t,
}: {
  readonly detail: EventDetail;
  readonly t: Translate;
}) {
  return (
    <ExpandableSection
      variant="container"
      defaultExpanded={
        detail.status === "DRAFT" || detail.status === "DEPLOYING" || detail.status === "READY"
      }
      headerText={t("event_detail.teams_header", { count: detail.teams.length })}
      headerDescription={t("event_detail.teams_description")}
    >
      <Table
        variant="embedded"
        items={[...detail.teams]}
        columnDefinitions={[
          {
            id: "slug",
            header: t("event_detail.teams_col_slug"),
            cell: (tr) => <code>{tr.internalSlug}</code>,
          },
          {
            id: "displayName",
            header: t("event_detail.teams_col_display_name"),
            cell: (tr) =>
              tr.displayName ?? (
                <Box variant="small" color="text-status-inactive">
                  {t("event_detail.teams_col_display_name_unset")}
                </Box>
              ),
          },
          {
            id: "account",
            header: t("event_detail.teams_col_account"),
            cell: (tr) =>
              tr.awsAccountId ? (
                <code>{tr.awsAccountId}</code>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  {t("event_detail.teams_col_account_legacy")}
                </Box>
              ),
          },
          {
            id: "key",
            header: t("event_detail.teams_col_login_key"),
            cell: (tr) =>
              tr.teamLoginKey ? (
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <Box variant="code" fontSize="body-s">
                    {tr.teamLoginKey}
                  </Box>
                  <Button
                    iconName="copy"
                    variant="inline-icon"
                    ariaLabel={t("event_detail.teams_col_login_key_aria", {
                      slug: tr.internalSlug,
                    })}
                    onClick={() => void navigator.clipboard?.writeText(tr.teamLoginKey ?? "")}
                  />
                </SpaceBetween>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  {t("event_detail.teams_col_login_key_legacy")}
                </Box>
              ),
          },
        ]}
        empty={<Box>{t("event_detail.teams_empty")}</Box>}
      />
    </ExpandableSection>
  );
}

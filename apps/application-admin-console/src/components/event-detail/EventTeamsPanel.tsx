import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import type { EventDetail } from "../../api/events-client";
import { buildInviteLink } from "../../lib/invite-link";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventTeamsPanel({
  detail,
  participantPortalUrl,
  t,
}: {
  readonly detail: EventDetail;
  /** 設定されているときだけ各 team 行に招待リンクコピーを出す (#1772)。 */
  readonly participantPortalUrl?: string;
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
                    // teamLoginKey truthy の row だけ copy button を出すので ?? "" 右辺は不到達。
                    /* v8 ignore next */
                    onClick={() => void navigator.clipboard?.writeText(tr.teamLoginKey ?? "")}
                  />
                  {participantPortalUrl && (
                    <Button
                      iconName="share"
                      variant="inline-icon"
                      ariaLabel={t("event_detail.teams_col_invite_link_aria", {
                        slug: tr.internalSlug,
                      })}
                      onClick={() =>
                        void navigator.clipboard?.writeText(
                          // teamLoginKey truthy の row だけ render されるので ?? "" 右辺は不到達。
                          /* v8 ignore next */
                          buildInviteLink(participantPortalUrl, tr.teamLoginKey ?? ""),
                        )
                      }
                    />
                  )}
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

import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { TFn } from "./types";

/** チーム引き渡し用 login key を表示し、 clipboard へコピーできるボタンを置く。 */
export function HandoffSection({
  teamLoginKey,
  t,
}: {
  readonly teamLoginKey: string;
  readonly t: TFn;
}) {
  return (
    <Container
      header={
        <Header variant="h2" description={t("deployment_detail.handoff_description")}>
          {t("deployment_detail.handoff_header")}
        </Header>
      }
    >
      <KeyValuePairs
        items={[
          {
            label: t("deployment_detail.label_team_login_key"),
            value: (
              <SpaceBetween direction="horizontal" size="xs">
                <Box variant="code">{teamLoginKey}</Box>
                <Button
                  iconName="copy"
                  ariaLabel={t("deployment_detail.copy_login_key_aria")}
                  onClick={() => void navigator.clipboard?.writeText(teamLoginKey)}
                >
                  {t("deployment_detail.copy")}
                </Button>
              </SpaceBetween>
            ),
          },
        ]}
      />
    </Container>
  );
}

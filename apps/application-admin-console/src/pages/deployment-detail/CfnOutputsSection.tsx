import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import type { TFn } from "./types";

/** CFn の Outputs を KeyValuePairs として表示する。 */
export function CfnOutputsSection({
  outputs,
  t,
}: {
  readonly outputs: Readonly<Record<string, string>>;
  readonly t: TFn;
}) {
  return (
    <Container header={<Header variant="h2">{t("deployment_detail.cfn_outputs_header")}</Header>}>
      <KeyValuePairs
        items={Object.entries(outputs).map(([label, value]) => ({
          label,
          value: <code>{value}</code>,
        }))}
      />
    </Container>
  );
}

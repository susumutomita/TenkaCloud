import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useT } from "../../i18n";
import { type ProblemRow, REGION_OPTIONS, resolveRegionOptions } from "./helpers";

/**
 * 「使う問題」 section: 問題 multiselect + 選択された問題ごとの region picker。
 *
 * region 選択肢は問題 metadata の `supportedRegions` 宣言を尊重 (Issue #1201 Phase 2)。
 */
export interface EventCreateProblemsetSectionProps {
  problemOptions: readonly MultiselectProps.Option[];
  selectedProblems: readonly MultiselectProps.Option[];
  problemRows: readonly ProblemRow[];
  onProblemsChange: (next: readonly MultiselectProps.Option[]) => void;
  onUpdateProblemRow: (problemId: string, patch: Partial<ProblemRow>) => void;
}

export function EventCreateProblemsetSection({
  problemOptions,
  selectedProblems,
  problemRows,
  onProblemsChange,
  onUpdateProblemRow,
}: EventCreateProblemsetSectionProps) {
  const t = useT();
  return (
    <Container header={<Header variant="h2">{t("event_create.problemset_header")}</Header>}>
      <SpaceBetween size="m">
        <FormField
          label={t("event_create.use_problems_label")}
          description={t("event_create.use_problems_description")}
        >
          <Multiselect
            selectedOptions={[...selectedProblems]}
            options={[...problemOptions]}
            placeholder={t("event_create.problemset_placeholder")}
            onChange={({ detail }) => onProblemsChange(detail.selectedOptions)}
          />
        </FormField>

        {problemRows.length > 0 && (
          <Table
            variant="embedded"
            items={[...problemRows]}
            columnDefinitions={[
              {
                id: "name",
                header: t("event_create.col_problem"),
                cell: (r) => r.problemName,
              },
              {
                id: "region",
                header: t("event_create.col_region"),
                cell: (r) => {
                  const options = resolveRegionOptions(r.supportedRegions, REGION_OPTIONS);
                  return (
                    <Select
                      selectedOption={
                        options.find((o) => o.value === r.defaultRegion) ?? options[0]
                      }
                      options={[...options]}
                      onChange={({ detail }) =>
                        onUpdateProblemRow(r.problemId, {
                          // Select の onChange は常に選択肢 (value 付き) を伴うので ?? の右辺は不到達 (= 防御)。
                          /* v8 ignore next */
                          defaultRegion: detail.selectedOption?.value ?? r.defaultRegion,
                        })
                      }
                      expandToViewport
                    />
                  );
                },
              },
            ]}
          />
        )}
      </SpaceBetween>
    </Container>
  );
}

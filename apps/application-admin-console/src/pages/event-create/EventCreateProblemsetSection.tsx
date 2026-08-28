import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useMemo, useState } from "react";
import { ProblemCostSummary } from "../../components/ProblemCostSummary";
import {
  enabledNonAwsProviders,
  type ProblemCategory,
  type ProblemSummary,
} from "../../data/problems";
import { interpolate, useT } from "../../i18n";
import {
  collectScoringKindFacets,
  collectTagFacets,
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
  EMPTY_FILTER_CRITERIA,
  filterProblems,
  isFilterActive,
  type ProblemFilterCriteria,
} from "../../lib/problem-filter";
import {
  buildProblemOptions,
  type ProblemRow,
  REGION_OPTIONS,
  resolveRegionOptions,
} from "./helpers";

/** Select の "全カテゴリ" sentinel。 catalog の category 値 (Battle/Challenge) と衝突しない。 */
const CATEGORY_ALL = "all";

/** Multiselect 選択値 (string のみ) を取り出す共通 helper。 */
function optionValues(options: readonly MultiselectProps.Option[]): string[] {
  return options.map((o) => o.value).filter((v): v is string => typeof v === "string");
}

/**
 * 「使う問題」 section: 検索 + filter (Issue #1776) + 問題 multiselect + 選択された問題ごとの
 * region picker。
 *
 * Issue #1776: カタログ増加 (Battle + Challenge 100+) に備え、 multiselect の選択肢を
 * 検索 (id / name / 説明 / タグ) と category / 難易度 / scoring kind / タグ filter で
 * 絞り込めるようにする。 filter logic は問題カタログ page と同じ `lib/problem-filter` を共用。
 *
 * region 選択肢は問題 metadata の `supportedRegions` 宣言を尊重 (Issue #1201 Phase 2)。
 */
export interface EventCreateProblemsetSectionProps {
  /** カタログ全件 (= filter 前)。 option 化 (#1414 の disabled 出し分け含む) は section 内で行う。 */
  problems: readonly ProblemSummary[];
  selectedProblems: readonly MultiselectProps.Option[];
  problemRows: readonly ProblemRow[];
  /**
   * #2167: multi-cloud (`features.nonAwsRuntime`) ON のとき、 working adapter を持つ
   * 非 AWS provider (sakura/azure/gcp) を picker で選択可能にする。 OFF (既定) では
   * 従来通り非 AWS 問題は disabled + 「近日対応」。
   */
  nonAwsRuntimeEnabled: boolean;
  onProblemsChange: (next: readonly MultiselectProps.Option[]) => void;
  onUpdateProblemRow: (problemId: string, patch: Partial<ProblemRow>) => void;
}

export function EventCreateProblemsetSection({
  problems,
  selectedProblems,
  problemRows,
  nonAwsRuntimeEnabled,
  onProblemsChange,
  onUpdateProblemRow,
}: EventCreateProblemsetSectionProps) {
  const t = useT();
  const [criteria, setCriteria] = useState<ProblemFilterCriteria>(EMPTY_FILTER_CRITERIA);
  const filtered = useMemo(() => filterProblems(problems, criteria), [problems, criteria]);
  const filterActive = isFilterActive(criteria);
  // #2167: flag が ON の間だけ非 AWS provider を選択可能集合に入れる。
  const enabledProviders = useMemo(
    () => enabledNonAwsProviders(nonAwsRuntimeEnabled),
    [nonAwsRuntimeEnabled],
  );
  // #1414 / #2167: 選択不可 runtime の問題は disabled + 「近日対応」 tag。
  const problemOptions = useMemo(
    () => buildProblemOptions(filtered, t("event_create.problem_reserved_tag"), enabledProviders),
    [filtered, t, enabledProviders],
  );
  const tagFacets = useMemo(() => collectTagFacets(problems), [problems]);
  const scoringKindFacets = useMemo(() => collectScoringKindFacets(problems), [problems]);

  const categoryOptions: SelectProps.Option[] = [
    { value: CATEGORY_ALL, label: t("problem_search.all_categories") },
    { value: "Battle", label: "Battle" },
    { value: "Challenge", label: "Challenge" },
  ];
  const selectedCategoryOption: SelectProps.Option =
    criteria.categories.length === 1
      ? { value: criteria.categories[0], label: criteria.categories[0] }
      : categoryOptions[0];

  const difficultyOptions: MultiselectProps.Option[] = DIFFICULTY_LEVELS.map((d) => ({
    value: String(d),
    label: `${d} (${t(`problems.difficulty_${d}`)})`,
  }));
  const difficultySelected: MultiselectProps.Option[] = criteria.difficulties.map((d) => ({
    value: String(d),
    label: String(d),
  }));
  const facetCount = (count: number): string =>
    interpolate(t("problem_search.facet_count"), { count: String(count) });
  const scoringKindOptions: MultiselectProps.Option[] = scoringKindFacets.map((f) => ({
    value: f.kind,
    label: f.kind,
    description: facetCount(f.count),
  }));
  const scoringKindSelected: MultiselectProps.Option[] = criteria.scoringKinds.map((kind) => ({
    value: kind,
    label: kind,
  }));
  const tagOptions: MultiselectProps.Option[] = tagFacets.map((f) => ({
    value: f.tag,
    label: f.tag,
    description: facetCount(f.count),
  }));
  const tagSelected: MultiselectProps.Option[] = criteria.tags.map((tag) => ({
    value: tag,
    label: tag,
  }));

  const clearFilters = () => setCriteria(EMPTY_FILTER_CRITERIA);

  return (
    <Container header={<Header variant="h2">{t("event_create.problemset_header")}</Header>}>
      <SpaceBetween size="m">
        <FormField
          label={t("problem_search.filter_label")}
          description={t("problem_search.filter_description")}
          stretch
        >
          <SpaceBetween size="xs">
            <Input
              type="search"
              data-testid="problem-filter-search"
              value={criteria.search}
              placeholder={t("problem_search.search_placeholder")}
              onChange={({ detail }) => setCriteria((prev) => ({ ...prev, search: detail.value }))}
            />
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                data-testid="problem-filter-category"
                selectedOption={selectedCategoryOption}
                options={categoryOptions}
                onChange={({ detail }) =>
                  setCriteria((prev) => ({
                    ...prev,
                    categories:
                      detail.selectedOption.value === CATEGORY_ALL
                        ? []
                        : [detail.selectedOption.value as ProblemCategory],
                  }))
                }
              />
              <Multiselect
                data-testid="problem-filter-difficulty"
                placeholder={t("problem_search.difficulty_placeholder")}
                options={difficultyOptions}
                selectedOptions={difficultySelected}
                onChange={({ detail }) =>
                  setCriteria((prev) => ({
                    ...prev,
                    difficulties: detail.selectedOptions
                      .map((o) => Number(o.value))
                      .filter((n): n is DifficultyLevel =>
                        DIFFICULTY_LEVELS.includes(n as DifficultyLevel),
                      ),
                  }))
                }
              />
              <Multiselect
                data-testid="problem-filter-scoring-kind"
                placeholder={t("problem_search.scoring_kind_placeholder")}
                options={scoringKindOptions}
                selectedOptions={scoringKindSelected}
                onChange={({ detail }) =>
                  setCriteria((prev) => ({
                    ...prev,
                    scoringKinds: optionValues(detail.selectedOptions),
                  }))
                }
              />
              <Multiselect
                data-testid="problem-filter-tags"
                placeholder={t("problem_search.tag_placeholder")}
                options={tagOptions}
                selectedOptions={tagSelected}
                filteringType="auto"
                onChange={({ detail }) =>
                  setCriteria((prev) => ({ ...prev, tags: optionValues(detail.selectedOptions) }))
                }
              />
            </SpaceBetween>
            {filterActive && (
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Box variant="small">
                  {interpolate(t("problem_search.match_count"), {
                    filtered: String(filtered.length),
                    total: String(problems.length),
                  })}
                </Box>
                <Button
                  variant="inline-link"
                  data-testid="problem-filter-clear"
                  onClick={clearFilters}
                >
                  {t("problem_search.clear_filters")}
                </Button>
              </SpaceBetween>
            )}
          </SpaceBetween>
        </FormField>

        <FormField
          label={t("event_create.use_problems_label")}
          description={t("event_create.use_problems_description")}
        >
          <Multiselect
            data-testid="problem-select"
            selectedOptions={[...selectedProblems]}
            options={[...problemOptions]}
            placeholder={t("event_create.problemset_placeholder")}
            empty={t("problem_search.empty_filtered")}
            onChange={({ detail }) => onProblemsChange(detail.selectedOptions)}
          />
        </FormField>

        {filterActive && filtered.length === 0 && (
          <Box textAlign="center" color="text-body-secondary">
            <SpaceBetween size="xs">
              <Box variant="p">{t("problem_search.empty_filtered")}</Box>
              <Button data-testid="problem-filter-empty-clear" onClick={clearFilters}>
                {t("problem_search.clear_filters")}
              </Button>
            </SpaceBetween>
          </Box>
        )}

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
              {
                id: "estimatedCost",
                header: t("event_create.col_estimated_cost"),
                cell: (r) => (
                  <ProblemCostSummary estimate={r.costEstimate} showResourceTypes={false} t={t} />
                ),
              },
            ]}
          />
        )}
      </SpaceBetween>
    </Container>
  );
}

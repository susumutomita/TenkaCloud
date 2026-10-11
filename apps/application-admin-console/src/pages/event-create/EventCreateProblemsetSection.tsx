import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import TokenGroup from "@cloudscape-design/components/token-group";
import { lazy, Suspense, useMemo, useState } from "react";
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
import { problemThemeLabel } from "../../lib/problem-themes";
import { LOCAL_HOST_BUILD } from "../../local-host-build";
import {
  buildProblemOptions,
  type ProblemRow,
  REGION_OPTIONS,
  resolveRegionOptions,
} from "./helpers";
import type { HostCatalog } from "./LocalHostEventCreate";
import { ScrollableProblemList } from "./ScrollableProblemList";

const LocalSemanticSearch = LOCAL_HOST_BUILD
  ? lazy(async () => ({ default: (await import("./SemanticProblemSearch")).SemanticProblemSearch }))
  : null;

/** Select の "全カテゴリ" sentinel。 catalog の category 値 (Battle/Challenge) と衝突しない。 */
const CATEGORY_ALL = "all";

/** Multiselect 選択値 (string のみ) を取り出す共通 helper。 */
function optionValues(options: readonly MultiselectProps.Option[]): string[] {
  return options.map((o) => o.value).filter((v): v is string => typeof v === "string");
}

/**
 * 「使う問題」 section: 検索 + filter + 常時表示のチェック一覧 + 選択された問題ごとの
 * region picker。
 *
 * カタログ増加 (Battle + Challenge 100+) に備え、常時表示の問題一覧を
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
  /**
   * Issue #3226: on the local competition host, the problems its catalog supports. Others are
   * disabled, and the cloud-only region / cost columns are not shown.
   */
  hostSupportedProblemIds?: ReadonlySet<string>;
  maxProblems?: number;
  hostCatalog?: HostCatalog;
  onProblemsChange: (next: readonly MultiselectProps.Option[]) => void;
  onUpdateProblemRow: (problemId: string, patch: Partial<ProblemRow>) => void;
}

export function EventCreateProblemsetSection({
  problems,
  selectedProblems,
  problemRows,
  nonAwsRuntimeEnabled,
  hostSupportedProblemIds,
  maxProblems,
  hostCatalog,
  onProblemsChange,
  onUpdateProblemRow,
}: EventCreateProblemsetSectionProps) {
  const t = useT();
  const [purposeHelpOpen, setPurposeHelpOpen] = useState(false);
  const [semanticIds, setSemanticIds] = useState<readonly string[] | null>(null);
  const [criteria, setCriteria] = useState<ProblemFilterCriteria>(EMPTY_FILTER_CRITERIA);
  const filtered = useMemo(() => filterProblems(problems, criteria), [problems, criteria]);
  const visibleProblems = useMemo(
    () =>
      semanticIds === null
        ? filtered
        : semanticIds.flatMap((id) => filtered.filter((p) => p.id === id)),
    [filtered, semanticIds],
  );
  const coordinationSelected = selectedProblems.some((option) =>
    hostCatalog?.coordination?.has(option.value ?? ""),
  );
  const filterActive = isFilterActive(criteria);
  // #2167: flag が ON の間だけ非 AWS provider を選択可能集合に入れる。
  const enabledProviders = useMemo(
    () => enabledNonAwsProviders(nonAwsRuntimeEnabled),
    [nonAwsRuntimeEnabled],
  );
  // #1414 / #2167: 選択不可 runtime の問題は disabled + 「近日対応」 tag。
  const problemOptions = useMemo(() => {
    const options = buildProblemOptions(
      visibleProblems,
      t(
        hostSupportedProblemIds
          ? "local_host.problem_unsupported_tag"
          : "event_create.problem_reserved_tag",
      ),
      enabledProviders,
      hostSupportedProblemIds,
    );
    const constrained = options.map((option) => ({
      ...option,
      disabled:
        option.disabled ||
        (coordinationSelected &&
          Boolean(hostCatalog?.coordination?.has(option.value ?? "")) &&
          !selectedProblems.some((selected) => selected.value === option.value)),
    }));
    if (maxProblems === undefined || selectedProblems.length < maxProblems) return constrained;
    const selected = new Set(selectedProblems.map((option) => option.value));
    return constrained.map((option) => ({
      ...option,
      disabled: option.disabled || !selected.has(option.value),
    }));
  }, [
    visibleProblems,
    t,
    enabledProviders,
    hostSupportedProblemIds,
    maxProblems,
    selectedProblems,
    hostCatalog?.coordination,
    coordinationSelected,
  ]);
  // Refresh selected text from the whole catalog, even when filters hide the selection.
  const displayedSelection = useMemo(() => {
    const options = buildProblemOptions(problems, "", enabledProviders, hostSupportedProblemIds);
    return selectedProblems.map((selected) => {
      const option = options.find((candidate) => candidate.value === selected.value);
      const problem = problems.find((candidate) => candidate.id === selected.value);
      return option && problem
        ? { ...selected, label: option.label, description: problem.shortDescription }
        : selected;
    });
  }, [problems, selectedProblems, enabledProviders, hostSupportedProblemIds]);
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
    label: problemThemeLabel(f.tag, t),
    description: facetCount(f.count),
  }));
  const tagSelected: MultiselectProps.Option[] = criteria.tags.map((tag) => ({
    value: tag,
    label: problemThemeLabel(tag, t),
  }));

  const clearFilters = () => setCriteria(EMPTY_FILTER_CRITERIA);

  return (
    <Container header={<Header variant="h2">{t("event_create.problemset_header")}</Header>}>
      <SpaceBetween size="m">
        {hostCatalog && LocalSemanticSearch && (
          <ExpandableSection
            headerText="問題選択のヘルプ"
            expanded={purposeHelpOpen}
            onChange={({ detail }) => {
              setPurposeHelpOpen(detail.expanded);
              if (!detail.expanded) setSemanticIds(null);
            }}
          >
            {purposeHelpOpen && (
              <Suspense fallback={<Box variant="p">検索の画面を読み込んでいます…</Box>}>
                <LocalSemanticSearch
                  problems={filtered}
                  catalog={hostCatalog}
                  onCandidates={setSemanticIds}
                />
              </Suspense>
            )}
          </ExpandableSection>
        )}
        <FormField
          label={t("problem_search.filter_label")}
          description={t("problem_search.filter_description")}
          stretch
        >
          <SpaceBetween size="xs">
            <Input
              type="search"
              ariaLabel={t("problems.search_label")}
              data-testid="problem-filter-search"
              value={criteria.search}
              placeholder={t("problem_search.search_placeholder")}
              onChange={({ detail }) => setCriteria((prev) => ({ ...prev, search: detail.value }))}
            />
            <ColumnLayout columns={2}>
              <FormField label={t("problems.theme_label")}>
                <Multiselect
                  expandToViewport
                  data-testid="problem-filter-tags"
                  placeholder={t("problem_search.tag_placeholder")}
                  options={tagOptions}
                  selectedOptions={tagSelected}
                  filteringType="auto"
                  onChange={({ detail }) =>
                    setCriteria((prev) => ({ ...prev, tags: optionValues(detail.selectedOptions) }))
                  }
                />
              </FormField>
              <FormField label={t("problems.difficulty_label")}>
                <Multiselect
                  expandToViewport
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
              </FormField>
            </ColumnLayout>
            <ExpandableSection headerText={t("problem_search.more_filters")}>
              <ColumnLayout columns={2}>
                <FormField label={t("problem_search.all_categories")}>
                  <Select
                    expandToViewport
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
                </FormField>
                <FormField label={t("problem_search.scoring_kind_placeholder")}>
                  <Multiselect
                    expandToViewport
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
                </FormField>
              </ColumnLayout>
            </ExpandableSection>
            {filterActive && (
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Box variant="small">
                  {interpolate(t("problem_search.match_count"), {
                    filtered: String(visibleProblems.length),
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
          constraintText={t("problem_search.selection_preserved")}
          description={
            maxProblems === undefined
              ? t("event_create.use_problems_description")
              : t("event_create.problem_selection_count", {
                  count: selectedProblems.length,
                  max: maxProblems,
                })
          }
        >
          <SpaceBetween size="s">
            {hostCatalog?.coordination && hostCatalog.coordination.size > 0 && (
              <Box variant="p" data-testid="coordination-selection-help">
                {t("problem_search.coordination_limit")}
                {coordinationSelected && <> {t("problem_search.coordination_change")}</>}
              </Box>
            )}
            <ScrollableProblemList label={t("event_create.use_problems_label")}>
              <fieldset
                aria-label={t("event_create.use_problems_label")}
                data-testid="problem-select"
                style={{
                  border: 0,
                  margin: 0,
                  padding: 0,
                  minInlineSize: 0,
                  overflowWrap: "anywhere",
                }}
              >
                {problemOptions.map((option) => {
                  const checked = displayedSelection.some((item) => item.value === option.value);
                  return (
                    <Box key={option.value} padding={{ vertical: "xs" }}>
                      <Checkbox
                        data-testid={`problem-checkbox-${option.value}`}
                        checked={checked}
                        disabled={Boolean(option.disabled && !checked)}
                        description={
                          <span
                            style={{
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            {option.description}
                          </span>
                        }
                        onChange={({ detail }) => {
                          if (!detail.checked)
                            onProblemsChange(
                              displayedSelection.filter((item) => item.value !== option.value),
                            );
                          else onProblemsChange([...displayedSelection, option]);
                        }}
                      >
                        <Box
                          variant="span"
                          fontWeight="bold"
                          data-testid={`problem-title-${option.value}`}
                        >
                          {option.label}
                        </Box>
                        {option.labelTag && (
                          <Box variant="span" color="text-body-secondary">
                            {" "}
                            — {option.labelTag}
                          </Box>
                        )}
                      </Checkbox>
                    </Box>
                  );
                })}
              </fieldset>
            </ScrollableProblemList>
            {displayedSelection.length > 0 && (
              <TokenGroup
                data-testid="problem-selection"
                disableOuterPadding
                items={displayedSelection.map((option) => ({
                  label: option.label,
                  description: option.description,
                  dismissLabel: t("problem_search.remove_selected", {
                    name: option.label ?? option.value ?? "",
                  }),
                }))}
                onDismiss={({ detail }) =>
                  onProblemsChange(
                    displayedSelection.filter((_, index) => index !== detail.itemIndex),
                  )
                }
              />
            )}
          </SpaceBetween>
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

        {problemRows.length > 0 && !hostSupportedProblemIds && (
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
                  if (r.runtimeProvider === "native") return t("event_create.native_execution");
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
                cell: (r) =>
                  r.runtimeProvider === "native" ? (
                    "—"
                  ) : (
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

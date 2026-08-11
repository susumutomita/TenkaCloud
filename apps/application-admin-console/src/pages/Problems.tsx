import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Cards from "@cloudscape-design/components/cards";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import SegmentedControl, {
  type SegmentedControlProps,
} from "@cloudscape-design/components/segmented-control";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ProblemCostSummary } from "../components/ProblemCostSummary";
import {
  listProblemSummaries,
  PROVIDER_LABEL,
  type ProblemRuntimeSummary,
  type ProblemSummary,
  runtimeProviders,
} from "../data/problems";
import { interpolate, useT } from "../i18n";
import {
  collectTagFacets,
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
  EMPTY_FILTER_CRITERIA,
  filterProblems,
  isFilterActive,
  type ProblemFilterCriteria,
  toggleTagFilter,
} from "../lib/problem-filter";

const PROBLEM_PACK_DOCS_URL =
  "https://github.com/susumutomita/TenkaCloud/tree/main/apps/developer-portal/src/app/developers/docs/tutorials/first-pack";
const OFFICIAL_CATALOG_REPO_URL = "https://github.com/susumutomita/TenkaCloudChallenge";

function providerBadge(runtime: ProblemRuntimeSummary): {
  readonly label: string;
  readonly awsOnly: boolean;
} {
  const providers = runtimeProviders(runtime);
  return {
    label: providers.map((provider) => PROVIDER_LABEL[provider] ?? provider).join(" / "),
    awsOnly: providers.every((provider) => provider === "aws"),
  };
}

const PACK_GUIDANCE_STEPS = [
  {
    labelKey: "problems.pack_guidance_step_init",
    command: 'make pack-init ARGS="./my-first-pack"',
  },
  {
    labelKey: "problems.pack_guidance_step_validate",
    command: 'make pack-validate ARGS="./my-first-pack"',
  },
  {
    labelKey: "problems.pack_guidance_step_install",
    command: 'make pack-install ARGS="./my-first-pack"',
  },
  {
    labelKey: "problems.pack_guidance_step_activate",
    command: 'make pack-activate ARGS="com.example.starter@0.1.0 --tenant <tenant-id>"',
  },
  { labelKey: "problems.pack_guidance_step_create_event" },
] as const;

type ProblemsT = ReturnType<typeof useT>;

function ProblemPackGuidanceModal({
  visible,
  onDismiss,
  t,
}: {
  readonly visible: boolean;
  readonly onDismiss: () => void;
  readonly t: ProblemsT;
}) {
  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={t("problems.pack_guidance_modal_title")}
      size="large"
    >
      <SpaceBetween size="l">
        <Box variant="p">{t("problems.pack_guidance_modal_description")}</Box>

        <SpaceBetween size="m">
          <Box>
            <Box variant="awsui-key-label">
              <Link external href={OFFICIAL_CATALOG_REPO_URL}>
                {t("problems.pack_guidance_path_official_title")}
              </Link>
            </Box>
            <Box>{t("problems.pack_guidance_path_official_body")}</Box>
          </Box>
          <Box>
            <Box variant="awsui-key-label">{t("problems.pack_guidance_path_private_title")}</Box>
            <Box>{t("problems.pack_guidance_path_private_body")}</Box>
          </Box>
        </SpaceBetween>

        <SpaceBetween size="s">
          <Box variant="awsui-key-label">{t("problems.pack_guidance_cli_heading")}</Box>
          <SpaceBetween size="xs">
            {PACK_GUIDANCE_STEPS.map((step, index) => (
              <Box key={step.labelKey}>
                <Box variant="awsui-key-label" display="inline">
                  {index + 1}.
                </Box>{" "}
                {t(step.labelKey)}
                {"command" in step ? (
                  <Box variant="code" fontSize="body-s">
                    {step.command}
                  </Box>
                ) : null}
              </Box>
            ))}
          </SpaceBetween>
          <Box color="text-body-secondary">{t("problems.pack_guidance_create_event_note")}</Box>
          <Link external href={PROBLEM_PACK_DOCS_URL}>
            {t("problems.pack_guidance_docs_link")}
          </Link>
        </SpaceBetween>
      </SpaceBetween>
    </Modal>
  );
}

/**
 * 問題一覧ページ。Cloudscape Cards で 1 件ずつカード表示する。
 * クリックすると /problems/:id へ遷移して詳細 + Deploy ボタン。
 *
 * Issue #834 / #835: 検索 box / category / status / 難易度 / タグ filter を提供。
 * tag badge は click で 「そのタグだけで絞り込み」 (= toggle、 同タグ 2 回 click で解除)。
 *
 * i18n: 全 UI strings は \`t()\` 経由で locale に追従する。 problem metadata (name /
 * shortDescription / tag literal) は author が書いた JP 文字列なので i18n 対象外
 * (= 別 issue で metadata に \`description_en\` 等を加える必要がある)。
 */
export function ProblemsPage() {
  const navigate = useNavigate();
  const t = useT();
  const problems = listProblemSummaries();
  const [criteria, setCriteria] = useState<ProblemFilterCriteria>(EMPTY_FILTER_CRITERIA);
  const [packGuidanceOpen, setPackGuidanceOpen] = useState(false);

  const filtered = useMemo(() => filterProblems(problems, criteria), [problems, criteria]);
  const tagFacets = useMemo(() => collectTagFacets(problems), [problems]);
  const openPackGuidance = () => setPackGuidanceOpen(true);
  const closePackGuidance = () => setPackGuidanceOpen(false);

  const difficultyLabel = (d: ProblemSummary["difficulty"]): string =>
    t(`problems.difficulty_${d}`);

  const categorySegments: SegmentedControlProps.Option[] = [
    { id: "all", text: t("problems.all") },
    { id: "Battle", text: "Battle" },
    { id: "Challenge", text: "Challenge" },
  ];

  const tagOptions: MultiselectProps.Option[] = useMemo(
    () =>
      tagFacets.map((f) => ({
        value: f.tag,
        label: f.tag,
        description: interpolate(t("problems.tag_facet_count"), { count: String(f.count) }),
      })),
    [tagFacets, t],
  );
  const tagSelected: MultiselectProps.Option[] = useMemo(
    () => criteria.tags.map((tag) => ({ value: tag, label: tag })),
    [criteria.tags],
  );
  // difficulty options は DIFFICULTY_LEVELS (= 5 件 固定) を locale ごとに label 化する。
  // useMemo にせず render ごとに作り直しても cost 無視できる範囲、 locale 切替時に追従させる。
  const difficultyOptions: MultiselectProps.Option[] = DIFFICULTY_LEVELS.map((d) => ({
    value: String(d),
    label: `${d} (${difficultyLabel(d)})`,
  }));
  const difficultySelected: MultiselectProps.Option[] = useMemo(
    () => criteria.difficulties.map((d) => ({ value: String(d), label: `${d}` })),
    [criteria.difficulties],
  );

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("problems.description")}
        counter={
          isFilterActive(criteria)
            ? `(${filtered.length} / ${problems.length})`
            : `(${problems.length})`
        }
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            {isFilterActive(criteria) ? (
              <Button onClick={() => setCriteria(EMPTY_FILTER_CRITERIA)}>
                {t("problems.clear_filter")}
              </Button>
            ) : null}
            <Button
              iconName="add-plus"
              onClick={openPackGuidance}
              data-testid="problem-pack-guidance-open-header"
            >
              {t("problems.pack_guidance_open")}
            </Button>
          </SpaceBetween>
        }
      >
        {t("problems.header")}
      </Header>

      <SpaceBetween size="s">
        <Input
          type="search"
          value={criteria.search}
          placeholder={t("problems.search_placeholder")}
          onChange={({ detail }) => setCriteria((prev) => ({ ...prev, search: detail.value }))}
        />
        <SpaceBetween direction="horizontal" size="s">
          <SegmentedControl
            selectedId={criteria.categories.length === 1 ? criteria.categories[0] : "all"}
            options={categorySegments}
            label={t("problems.category_label")}
            onChange={({ detail }) =>
              setCriteria((prev) => ({
                ...prev,
                categories:
                  detail.selectedId === "all"
                    ? []
                    : [detail.selectedId as ProblemSummary["category"]],
              }))
            }
          />
        </SpaceBetween>
        <SpaceBetween direction="horizontal" size="s">
          <Multiselect
            placeholder={t("problems.difficulty_placeholder")}
            options={difficultyOptions}
            selectedOptions={difficultySelected}
            tokenLimit={5}
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
            placeholder={
              criteria.tagMatchMode === "and"
                ? t("problems.tag_placeholder_and")
                : t("problems.tag_placeholder_or")
            }
            options={tagOptions}
            selectedOptions={tagSelected}
            tokenLimit={10}
            // タグ数が増えると dropdown を縦スクロールで探すのが辛い (= 利用者報告)。
            // filteringType="auto" で dropdown 上部に inline search box を出す。
            filteringType="auto"
            filteringPlaceholder={t("problems.tag_filter_placeholder")}
            onChange={({ detail }) =>
              setCriteria((prev) => ({
                ...prev,
                tags: detail.selectedOptions
                  .map((o) => o.value)
                  .filter((v): v is string => typeof v === "string"),
              }))
            }
          />
          {criteria.tags.length > 1 && (
            <Button
              onClick={() =>
                setCriteria((prev) => ({
                  ...prev,
                  tagMatchMode: prev.tagMatchMode === "and" ? "or" : "and",
                }))
              }
            >
              {criteria.tagMatchMode === "and"
                ? t("problems.tag_match_and_button")
                : t("problems.tag_match_or_button")}
            </Button>
          )}
        </SpaceBetween>
      </SpaceBetween>

      <Cards
        items={[...filtered]}
        cardDefinition={{
          header: (item) => (
            <Link
              fontSize="heading-m"
              onFollow={(e) => {
                e.preventDefault();
                navigate(`/problems/${encodeURIComponent(item.id)}`);
              }}
              href={`/problems/${encodeURIComponent(item.id)}`}
            >
              {item.name}
            </Link>
          ),
          sections: [
            {
              id: "badges",
              content: (item) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Badge color={item.category === "Battle" ? "red" : "blue"}>{item.category}</Badge>
                  {/* deploy 先 cloud。AWS 以外は緑で強調する。 */}
                  <Badge color={providerBadge(item.runtime).awsOnly ? "grey" : "green"}>
                    {providerBadge(item.runtime).label}
                  </Badge>
                  <Badge color="grey">
                    {interpolate(t("problems.badge_difficulty"), {
                      label: difficultyLabel(item.difficulty),
                    })}
                  </Badge>
                  <Badge color="grey">
                    {interpolate(t("problems.badge_duration"), {
                      duration: item.estimatedDuration,
                    })}
                  </Badge>
                  {/* Issue #2093: pack provenance badge — rendered ONLY for problems that
                      come from an installed pack. Core-only catalogs show no pack label. */}
                  {item.source === "pack" && item.packId && (
                    <Badge color="green">
                      {interpolate(t("problems.badge_pack"), { packId: item.packId })}
                    </Badge>
                  )}
                </SpaceBetween>
              ),
            },
            {
              id: "description",
              content: (item) => <Box variant="p">{item.shortDescription}</Box>,
            },
            {
              id: "cost",
              header: t("problem_cost.header"),
              content: (item) => <ProblemCostSummary estimate={item.costEstimate} t={t} />,
            },
            {
              id: "tags",
              header: t("problems.tags_header"),
              content: (item) => (
                <SpaceBetween direction="horizontal" size="xxs">
                  {item.tags.map((tag) => {
                    const isActive = criteria.tags.includes(tag);
                    return (
                      <Button
                        key={tag}
                        variant={isActive ? "primary" : "inline-link"}
                        onClick={() => setCriteria((prev) => toggleTagFilter(prev, tag))}
                        ariaLabel={interpolate(
                          isActive
                            ? t("problems.tag_active_aria")
                            : t("problems.tag_inactive_aria"),
                          { tag },
                        )}
                      >
                        {tag}
                      </Button>
                    );
                  })}
                </SpaceBetween>
              ),
            },
          ],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }]}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {isFilterActive(criteria) ? (
              <SpaceBetween size="s">
                <Box variant="p">{t("problems.empty_filtered")}</Box>
                <Button onClick={() => setCriteria(EMPTY_FILTER_CRITERIA)}>
                  {t("problems.clear_filter")}
                </Button>
              </SpaceBetween>
            ) : (
              <SpaceBetween size="s">
                <Box variant="p">{t("problems.empty")}</Box>
                <Box color="text-body-secondary">{t("problems.pack_guidance_empty_hint")}</Box>
                <Button onClick={openPackGuidance}>{t("problems.pack_guidance_open")}</Button>
              </SpaceBetween>
            )}
          </Box>
        }
      />

      <ProblemPackGuidanceModal visible={packGuidanceOpen} onDismiss={closePackGuidance} t={t} />
    </SpaceBetween>
  );
}

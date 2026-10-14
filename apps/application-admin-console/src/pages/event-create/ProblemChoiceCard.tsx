import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Checkbox from "@cloudscape-design/components/checkbox";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import type { MultiselectProps } from "@cloudscape-design/components/multiselect";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Markdown } from "@tenkacloud/web-kit";
import type { ProblemDetail, ProblemSummary } from "../../data/problems";
import { runtimeProviders } from "../../data/problems";
import { useT } from "../../i18n";
export type ProblemChoiceContent = Pick<ProblemDetail, "description" | "learningGoals">;
/** Inspection never changes the event's selection. */
export function ProblemChoiceCard({
  problem,
  option,
  checked,
  content,
  onChange,
}: {
  problem: ProblemSummary;
  option: MultiselectProps.Option;
  checked: boolean;
  content?: ProblemChoiceContent;
  onChange: (checked: boolean) => void;
}) {
  const t = useT();
  return (
    <article
      style={{
        border: `1px solid ${checked ? "#0972d3" : "#b6bec9"}`,
        borderRadius: 12,
        padding: 16,
        minWidth: 0,
        overflowWrap: "anywhere",
        background: checked ? "#f2f8fd" : undefined,
      }}
    >
      <SpaceBetween size="s">
        <SpaceBetween direction="horizontal" size="xs">
          <Badge>{problem.category}</Badge>
          <Box variant="span">{t(`problems.difficulty_${problem.difficulty}`)}</Box>
          {problem.estimatedDuration && <Box variant="span">{problem.estimatedDuration}</Box>}
        </SpaceBetween>
        <Checkbox
          data-testid={`problem-checkbox-${option.value}`}
          checked={checked}
          disabled={Boolean(option.disabled && !checked)}
          onChange={({ detail }) => onChange(detail.checked)}
        >
          <Box variant="span" fontWeight="bold" data-testid={`problem-title-${option.value}`}>
            {option.label}
          </Box>
        </Checkbox>
        <p
          style={{
            margin: 0,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {problem.shortDescription}
        </p>
        {content?.learningGoals[0] && (
          <p
            style={{
              margin: 0,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              fontSize: 14,
            }}
          >
            <strong>{t("problem_detail.section_learning_goals")}: </strong>
            {content.learningGoals[0]}
          </p>
        )}
        <Box variant="small" color="text-body-secondary">
          {t("event_create.execution_environment")}: {runtimeProviders(problem.runtime).join(" + ")}
          {"provider" in problem.runtime ? ` · ${problem.runtime.engine}` : ""}
        </Box>
        {option.labelTag && (
          <Box variant="small" color="text-status-inactive">
            {option.labelTag}
          </Box>
        )}
        {(content || problem.shortDescription) && (
          <ExpandableSection headerText={t("event_create.problem_details", { name: problem.name })}>
            <SpaceBetween size="s">
              {content && content.learningGoals.length > 0 && (
                <div>
                  <Box fontWeight="bold">{t("problem_detail.section_learning_goals")}</Box>
                  <ul style={{ paddingInlineStart: 20, marginBlock: 8 }}>
                    {content.learningGoals.map((goal) => (
                      <li key={goal}>{goal}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Markdown source={content?.description ?? problem.shortDescription} />
            </SpaceBetween>
          </ExpandableSection>
        )}
      </SpaceBetween>
    </article>
  );
}

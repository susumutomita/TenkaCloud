import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { ParticipantProblemView } from "../api/portal-client";
import { nextProblemDisplayName } from "../components/NextActionHero";
import type { TFn } from "./Quests.submission-state";

/**
 * [#2928] The local "where do I start" card. Extracted from `QuestsPage` so the branch
 * between the pinned intro drill and the course track lives in one readable place rather
 * than as nested ternaries inside an already-large render.
 *
 * When the platform has pinned an intro drill and the participant has solved nothing, that
 * drill is the primary action; the course track stays reachable as the secondary button.
 * Otherwise this is exactly the pre-#2928 card.
 */
export function LocalStartGuidance({
  t,
  navigate,
  introProblem,
  courseProblemName,
  courseJobId,
  locale,
}: {
  t: TFn;
  navigate: (to: string) => void;
  introProblem: ParticipantProblemView | undefined;
  courseProblemName: string | undefined;
  courseJobId: string | undefined;
  locale: "ja" | "en";
}) {
  const showCourseCta = !introProblem && courseProblemName !== undefined && courseJobId;
  return (
    <Alert
      type="info"
      header={t(introProblem ? "quests.local_start_intro_header" : "quests.local_start_header")}
      data-testid="local-start-guidance"
    >
      <SpaceBetween size="s">
        <Box>
          {t(introProblem ? "quests.local_start_intro_body" : "quests.local_start_course_body")}
        </Box>
        <SpaceBetween size="xs" direction="horizontal">
          {introProblem ? (
            <Button
              variant="primary"
              data-testid="local-intro-problem"
              onClick={() => navigate(`/problems/${encodeURIComponent(introProblem.jobId)}`)}
            >
              {t("quests.local_intro_problem", {
                name: nextProblemDisplayName(introProblem, locale),
              })}
            </Button>
          ) : null}
          {showCourseCta ? (
            <Button
              variant="primary"
              data-testid="local-next-problem"
              onClick={() => navigate(`/problems/${encodeURIComponent(courseJobId)}`)}
            >
              {t("quests.local_next_problem", { name: courseProblemName })}
            </Button>
          ) : null}
          <Button data-testid="course-tracks-link" onClick={() => navigate("/course-tracks")}>
            {t("quests.course_tracks_link")}
          </Button>
        </SpaceBetween>
        <Box color="text-body-secondary">{t("quests.local_start_other_body")}</Box>
      </SpaceBetween>
    </Alert>
  );
}

import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { EducationMaterialsResponse } from "../api/education-graph-client";

type TFn = (key: string) => string;

export function EducationMaterials({
  response,
  t,
}: {
  readonly response: EducationMaterialsResponse;
  readonly t: TFn;
}) {
  const { videoScript, textLesson, quiz } = response.materials;
  const hasMaterials =
    videoScript.segments.length > 0 || textLesson.sections.length > 0 || quiz.questions.length > 0;

  if (!hasMaterials)
    return <Box color="text-body-secondary">{t("education_graph.materials_empty")}</Box>;

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h3">{videoScript.title}</Header>}>
        <SpaceBetween size="m">
          {videoScript.segments.map((segment) => (
            <section key={segment.heading}>
              <Box variant="h4">{segment.heading}</Box>
              <Box variant="p">{segment.narration}</Box>
            </section>
          ))}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h3">{textLesson.title}</Header>}>
        <SpaceBetween size="m">
          {textLesson.sections.map((section) => (
            <section key={section.heading}>
              <Box variant="h4">{section.heading}</Box>
              <Box variant="p">{section.body}</Box>
            </section>
          ))}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h3">{quiz.title}</Header>}>
        <SpaceBetween size="m">
          {quiz.questions.map((question) => (
            <section key={question.id}>
              <Box variant="h4">{question.prompt}</Box>
              <dl>
                <dt>{t("education_graph.quiz_answer")}</dt>
                <dd>{question.answer}</dd>
                <dt>{t("education_graph.quiz_explanation")}</dt>
                <dd>{question.explanation}</dd>
              </dl>
            </section>
          ))}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

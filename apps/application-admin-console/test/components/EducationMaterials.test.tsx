import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EducationMaterialsResponse } from "../../src/api/education-graph-client";
import { EducationMaterials } from "../../src/components/EducationMaterials";

const t = (key: string) => key;

const RESPONSE: EducationMaterialsResponse = {
  problemId: "api-idor-demo",
  locale: "en",
  materials: {
    videoScript: {
      title: "Video: Object authorization",
      segments: [{ heading: "Opening", narration: "Authentication is not authorization." }],
    },
    textLesson: {
      title: "Text: Object authorization",
      sections: [{ heading: "Root cause", body: "Verify ownership for every object." }],
    },
    quiz: {
      title: "Quiz: Object authorization",
      questions: [
        {
          id: "q1",
          prompt: "What must the API verify?",
          answer: "Object ownership",
          explanation: "A valid login alone is insufficient.",
        },
      ],
    },
  },
};

describe("EducationMaterials", () => {
  it("should render video, text, and quiz projections from one response", () => {
    render(<EducationMaterials response={RESPONSE} t={t} />);

    expect(
      screen.getByRole("heading", { name: "Video: Object authorization" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Authentication is not authorization.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Text: Object authorization" })).toBeInTheDocument();
    expect(screen.getByText("Verify ownership for every object.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quiz: Object authorization" })).toBeInTheDocument();
    expect(screen.getByText("What must the API verify?")).toBeInTheDocument();
    expect(screen.getByText("Object ownership")).toBeInTheDocument();
    expect(screen.getByText("A valid login alone is insufficient.")).toBeInTheDocument();
  });

  it("should show an explicit empty state when every projection is empty", () => {
    render(
      <EducationMaterials
        response={{
          problemId: "empty",
          locale: "ja",
          materials: {
            videoScript: { title: "", segments: [] },
            textLesson: { title: "", sections: [] },
            quiz: { title: "", questions: [] },
          },
        }}
        t={t}
      />,
    );

    expect(screen.getByText("education_graph.materials_empty")).toBeInTheDocument();
  });
});

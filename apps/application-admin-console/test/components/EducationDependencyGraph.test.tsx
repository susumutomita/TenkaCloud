import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EducationGraphResponse } from "../../src/api/education-graph-client";
import { EducationDependencyGraph } from "../../src/components/EducationDependencyGraph";

const t = (key: string) => key;

const GRAPH: EducationGraphResponse = {
  locale: "en",
  nodes: [
    { id: "problem.api-idor-demo", type: "problem", label: "API IDOR" },
    {
      id: "lo.api-idor-demo.object-authorization",
      type: "learning_objective",
      label: "Check object authorization",
    },
    { id: "concept.authorization", type: "concept", label: "Authorization" },
    {
      id: "assessment.api-idor-demo.authorization",
      type: "assessment_criterion",
      label: "Reject cross-user access",
    },
    {
      id: "misconception.authentication-is-enough",
      type: "misconception",
      label: "Authentication is sufficient",
    },
    { id: "audience.engineer", type: "audience", label: "Engineer" },
    { id: "concept.disconnected", type: "concept", label: "Disconnected concept" },
  ],
  relations: [
    {
      type: "teaches",
      source: "problem.api-idor-demo",
      target: "lo.api-idor-demo.object-authorization",
    },
    {
      type: "requires",
      source: "lo.api-idor-demo.object-authorization",
      target: "concept.authorization",
    },
    {
      type: "assesses",
      source: "problem.api-idor-demo",
      target: "assessment.api-idor-demo.authorization",
    },
    {
      type: "related_to",
      source: "problem.api-idor-demo",
      target: "misconception.authentication-is-enough",
    },
    {
      type: "related_to",
      source: "problem.api-idor-demo",
      target: "audience.engineer",
    },
  ],
  problems: [{ id: "api-idor-demo", name: "API IDOR", nodeId: "problem.api-idor-demo" }],
};

describe("EducationDependencyGraph", () => {
  it("should render a visual graph plus a complete semantic relation list", () => {
    const { container } = render(<EducationDependencyGraph graph={GRAPH} t={t} />);

    const svg = container.querySelector("[data-testid='education-graph-svg']");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveTextContent("education_graph.node_type_problem");
    expect(svg).toHaveTextContent("education_graph.node_type_learning_objective");
    expect(svg).toHaveTextContent("education_graph.node_type_concept");
    expect(svg).toHaveTextContent("education_graph.node_type_assessment_criterion");
    expect(svg).toHaveTextContent("education_graph.node_type_misconception");
    expect(svg).toHaveTextContent("education_graph.node_type_audience");
    expect(svg).toHaveTextContent("education_graph.relation_teaches");

    const nodes = screen.getByRole("list", { name: "education_graph.nodes_label" });
    expect(within(nodes).getByText(/Disconnected concept/)).toHaveTextContent(
      "education_graph.node_type_concept",
    );
    expect(within(nodes).getAllByRole("listitem")).toHaveLength(GRAPH.nodes.length);

    const relations = screen.getByRole("list", { name: "education_graph.relations_label" });
    expect(
      within(relations).getByText(
        (_content, element) =>
          element?.tagName === "LI" &&
          element.textContent?.includes("education_graph.relation_teaches") === true,
      ),
    ).toHaveTextContent("API IDOR");
    expect(
      within(relations).getByText(
        (_content, element) =>
          element?.tagName === "LI" &&
          element.textContent?.includes("education_graph.relation_requires") === true,
      ),
    ).toHaveTextContent("Check object authorization");
  });

  it("should retain relation ids when an API response references a missing node", () => {
    render(
      <EducationDependencyGraph
        graph={{
          ...GRAPH,
          relations: [{ type: "covers", source: "missing.source", target: "missing.target" }],
        }}
        t={t}
      />,
    );

    expect(screen.getByText(/missing\.source/)).toHaveTextContent("missing.target");
  });
});

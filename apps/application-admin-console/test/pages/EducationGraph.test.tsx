import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../../src/api/client";
import type {
  EducationGraphResponse,
  EducationMaterialsResponse,
} from "../../src/api/education-graph-client";
import type { AppConfig } from "../../src/config";

const { mockUseApiClient, mockGetGraph, mockGetMaterials, mockLocale } = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockGetGraph: vi.fn(),
  mockGetMaterials: vi.fn(),
  mockLocale: { value: "ja" as "ja" | "en" },
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mockUseApiClient };
});
vi.mock("../../src/api/education-graph-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/education-graph-client")>();
  return {
    ...actual,
    getEducationGraph: mockGetGraph,
    getEducationMaterials: mockGetMaterials,
  };
});
vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ locale: mockLocale.value, t: (key: string) => key }),
}));

const { EducationGraphPage } = await import("../../src/pages/EducationGraph");

const config = {} as AppConfig;
const client = {} as ApiClient;
const graph: EducationGraphResponse = {
  locale: "ja",
  nodes: [
    { id: "problem.one", type: "problem", label: "Problem One", problemId: "one" },
    { id: "problem.two", type: "problem", label: "Problem Two", problemId: "two" },
  ],
  relations: [{ type: "related_to", source: "problem.one", target: "problem.two" }],
  problems: [
    { id: "one", name: "Problem One", nodeId: "problem.one" },
    { id: "two", name: "Problem Two", nodeId: "problem.two" },
  ],
};
const materials = (problemId: string): EducationMaterialsResponse => ({
  problemId,
  locale: "ja",
  materials: {
    videoScript: {
      title: `Video ${problemId}`,
      segments: [{ heading: "Opening", narration: `Narration ${problemId}` }],
    },
    textLesson: {
      title: `Text ${problemId}`,
      sections: [{ heading: "Lesson", body: `Body ${problemId}` }],
    },
    quiz: {
      title: `Quiz ${problemId}`,
      questions: [{ id: "q1", prompt: "Prompt", answer: "Answer", explanation: "Explanation" }],
    },
  },
});

beforeEach(() => {
  mockLocale.value = "ja";
  mockUseApiClient.mockReturnValue(client);
  mockGetGraph.mockResolvedValue(graph);
  mockGetMaterials.mockImplementation((_client: ApiClient, problemId: string) =>
    Promise.resolve(materials(problemId)),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EducationGraphPage", () => {
  it("should load the graph and the first problem's locale-specific materials", async () => {
    const { container } = render(<EducationGraphPage config={config} />);

    expect(screen.getByText("education_graph.loading_graph")).toBeInTheDocument();
    expect(await screen.findByText("Video one")).toBeInTheDocument();
    expect(mockGetGraph).toHaveBeenCalledWith(client, "ja");
    expect(mockGetMaterials).toHaveBeenCalledWith(client, "one", "ja");
    expect(container.querySelector("[data-testid='education-graph-svg']")).toBeInTheDocument();
  });

  it("should fetch another projection when the operator selects a problem", async () => {
    const { container } = render(<EducationGraphPage config={config} />);
    await screen.findByText("Video one");

    const select = createWrapper(container).findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("two");

    await waitFor(() => expect(mockGetMaterials).toHaveBeenLastCalledWith(client, "two", "ja"));
    expect(await screen.findByText("Video two")).toBeInTheDocument();
  });

  it("should preserve the selected problem across a locale refresh when it still exists", async () => {
    const { container, rerender } = render(<EducationGraphPage config={config} />);
    await screen.findByText("Video one");
    const select = createWrapper(container).findSelect();
    select?.openDropdown();
    select?.selectOptionByValue("two");
    await screen.findByText("Video two");

    mockLocale.value = "en";
    mockGetGraph.mockResolvedValue({ ...graph, locale: "en" });
    rerender(<EducationGraphPage config={config} />);

    await waitFor(() => expect(mockGetGraph).toHaveBeenLastCalledWith(client, "en"));
    await waitFor(() => expect(mockGetMaterials).toHaveBeenLastCalledWith(client, "two", "en"));
    expect(mockGetMaterials).not.toHaveBeenCalledWith(client, "one", "en");
  });

  it("should show a graph load error", async () => {
    mockGetGraph.mockRejectedValue(new Error("boom"));
    render(<EducationGraphPage config={config} />);

    expect(await screen.findByText("education_graph.graph_load_error")).toBeInTheDocument();
    expect(mockGetMaterials).not.toHaveBeenCalled();
  });

  it("should explain the TenantAdmin requirement for a forbidden direct URL", async () => {
    mockGetGraph.mockRejectedValue(new ApiError(403, "forbidden"));
    render(<EducationGraphPage config={config} />);

    expect(await screen.findByText("education_graph.admin_only_error")).toBeInTheDocument();
  });

  it("should show an explicit empty state for an empty graph", async () => {
    mockGetGraph.mockResolvedValue({ locale: "ja", nodes: [], relations: [], problems: [] });
    render(<EducationGraphPage config={config} />);

    expect(await screen.findByText("education_graph.graph_empty")).toBeInTheDocument();
    expect(mockGetMaterials).not.toHaveBeenCalled();
  });

  it("should explain when graph nodes exist without a material-producing problem", async () => {
    mockGetGraph.mockResolvedValue({
      locale: "ja",
      nodes: [{ id: "concept.authorization", type: "concept", label: "Authorization" }],
      relations: [],
      problems: [],
    });
    render(<EducationGraphPage config={config} />);

    expect(await screen.findByText("education_graph.no_problem_projections")).toBeInTheDocument();
    expect(mockGetMaterials).not.toHaveBeenCalled();
  });

  it("should show a materials load error without hiding the graph", async () => {
    mockGetMaterials.mockRejectedValue(new Error("boom"));
    const { container } = render(<EducationGraphPage config={config} />);

    expect(await screen.findByText("education_graph.materials_load_error")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='education-graph-svg']")).toBeInTheDocument();
  });

  it("should keep loading until an API client becomes available", () => {
    mockUseApiClient.mockReturnValue(null);
    render(<EducationGraphPage config={config} />);

    expect(screen.getByText("education_graph.loading_graph")).toBeInTheDocument();
    expect(mockGetGraph).not.toHaveBeenCalled();
  });

  it.each([
    "resolve",
    "reject",
  ] as const)("should ignore a graph %s after unmount", async (outcome) => {
    let settle: (() => void) | undefined;
    mockGetGraph.mockReturnValue(
      new Promise<EducationGraphResponse>((resolve, reject) => {
        settle = () => (outcome === "resolve" ? resolve(graph) : reject(new Error("late")));
      }),
    );
    const { unmount } = render(<EducationGraphPage config={config} />);

    unmount();
    settle?.();
    await Promise.resolve();
    expect(mockGetMaterials).not.toHaveBeenCalled();
  });

  it.each([
    "resolve",
    "reject",
  ] as const)("should ignore a materials %s after unmount", async (outcome) => {
    let settle: (() => void) | undefined;
    mockGetMaterials.mockReturnValue(
      new Promise<EducationMaterialsResponse>((resolve, reject) => {
        settle = () =>
          outcome === "resolve" ? resolve(materials("one")) : reject(new Error("late"));
      }),
    );
    const { unmount } = render(<EducationGraphPage config={config} />);
    await waitFor(() => expect(mockGetMaterials).toHaveBeenCalled());

    unmount();
    settle?.();
    await Promise.resolve();
    expect(mockGetMaterials).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import { getEducationGraph, getEducationMaterials } from "../../src/api/education-graph-client";

function clientWith(get: ReturnType<typeof vi.fn>): ApiClient {
  return { get } as unknown as ApiClient;
}

describe("education graph API client", () => {
  it("should fetch the tenant education graph", async () => {
    const get = vi.fn().mockResolvedValue({ nodes: [], relations: [], problems: [] });

    await getEducationGraph(clientWith(get), "ja");

    expect(get).toHaveBeenCalledWith("/admin/education-graph?locale=ja");
  });

  it("should fetch projected materials on the standard schema-valid problem path", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ problemId: "api-idor-demo", locale: "en", materials: {} });

    await getEducationMaterials(clientWith(get), "api-idor-demo", "en");

    expect(get).toHaveBeenCalledWith(
      "/admin/education-graph/problems/api-idor-demo/materials?locale=en",
    );
  });
});

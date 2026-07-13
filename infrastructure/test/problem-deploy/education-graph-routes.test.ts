import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerEducationGraphRoutes } from "../../lib/problem-deploy/handlers/event-handler/routes/education-graph";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { buildAuthErrorHandler } from "../../lib/problem-deploy/handlers/shared/auth-wiring";

const shared = {
  problemsEducationGraph: {
    "api-idor-demo": {
      problemId: "api-idor-demo",
      name: { ja: "管理者のメモ", en: "The Admin's Note" },
      shortDescription: { ja: "認可を学ぶ", en: "Learn authorization" },
      nodes: [
        {
          id: "lo.api-idor-demo.authorization",
          type: "learning_objective",
          label: "認可不備を発見できる",
          problemId: "api-idor-demo",
        },
      ],
      relations: [
        {
          type: "teaches",
          source: "problem.api-idor-demo",
          target: "lo.api-idor-demo.authorization",
        },
      ],
    },
  },
} as unknown as EventSharedResources;

function buildApp() {
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix: "[education-graph]" }));
  registerEducationGraphRoutes(app, shared);
  return app;
}

beforeEach(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

afterEach(() => {
  delete process.env.DEFAULT_TENANT_ID;
  delete process.env.DEFAULT_USER_ROLE;
});

describe("education graph admin routes", () => {
  it("should return the normalized graph to TenantAdmin", async () => {
    const response = await buildApp().request("/admin/education-graph?locale=ja");

    expect(response.status).toBe(StatusCodes.OK);
    expect(await response.json()).toMatchObject({
      locale: "ja",
      problems: [{ id: "api-idor-demo", nodeId: "problem.api-idor-demo" }],
    });
  });

  it.each(["TenantOperator", "TenantViewer"])('should reject role "%s"', async (role) => {
    process.env.DEFAULT_USER_ROLE = role;

    const response = await buildApp().request("/admin/education-graph");

    expect(response.status).toBe(StatusCodes.FORBIDDEN);
  });

  it("should return localized material projections", async () => {
    const response = await buildApp().request(
      "/admin/education-graph/problems/api-idor-demo/materials?locale=en",
    );

    expect(response.status).toBe(StatusCodes.OK);
    expect(await response.json()).toMatchObject({
      problemId: "api-idor-demo",
      locale: "en",
      materials: {
        videoScript: { title: "The Admin's Note - video script" },
        textLesson: { title: "The Admin's Note - text lesson" },
        quiz: { title: "The Admin's Note - quiz" },
      },
    });
  });

  it("should localize the graph response and default to Japanese", async () => {
    const english = await buildApp().request("/admin/education-graph?locale=en");
    const japanese = await buildApp().request("/admin/education-graph");

    expect((await english.json()).locale).toBe("en");
    expect((await japanese.json()).locale).toBe("ja");
  });

  it("should reject unsupported locales", async () => {
    const response = await buildApp().request(
      "/admin/education-graph/problems/api-idor-demo/materials?locale=fr",
    );

    expect(response.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await response.json()).toEqual({ error: "invalid_locale" });
  });

  it("should reject unsupported graph locales", async () => {
    const response = await buildApp().request("/admin/education-graph?locale=fr");

    expect(response.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await response.json()).toEqual({ error: "invalid_locale" });
  });

  it("should return 404 for an unknown or graph-less problem", async () => {
    const response = await buildApp().request(
      "/admin/education-graph/problems/not-in-graph/materials?locale=ja",
    );

    expect(response.status).toBe(StatusCodes.NOT_FOUND);
    expect(await response.json()).toEqual({
      error: "education_graph_not_found",
      problemId: "not-in-graph",
    });
  });

  it.each([
    "__proto__",
    "constructor",
  ])('should return 404 for inherited object key "%s"', async (problemId) => {
    const response = await buildApp().request(
      `/admin/education-graph/problems/${problemId}/materials?locale=ja`,
    );

    expect(response.status).toBe(StatusCodes.NOT_FOUND);
    expect(await response.json()).toEqual({
      error: "education_graph_not_found",
      problemId,
    });
  });
});

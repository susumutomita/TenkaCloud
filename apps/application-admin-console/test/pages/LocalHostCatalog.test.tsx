import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import { metadataToDetail } from "../../src/data/problem-mapping";
import type { ProblemMetadata } from "../../src/data/problem-types";
import { I18nProvider } from "../../src/i18n";
import { LocalHostCatalogPage } from "../../src/pages/LocalHostCatalog";

const { get, api } = vi.hoisted(() => {
  const get = vi.fn();
  return { get, api: { get } };
});
vi.mock("../../src/api/client", () => ({ useApiClient: () => api }));
vi.mock("../../src/data/problems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/problems")>();
  return {
    ...actual,
    listProblemSummaries: () => projected,
    findProblem: (id: string) => projected.find((problem) => problem.id === id),
  };
});

// Run the real Node-side build projection before rendering it in jsdom. Vite rewrites
// import.meta.url in jsdom, so the build plugin must run in its normal Bun environment.
const publicProblems = JSON.parse(
  execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- re-entrant Bun build fixture, fixed source and arguments
    "bun",
    [
      "-e",
      `
  import { readFileSync } from "node:fs";
  import { publicMetadata } from "./scripts/local-host/browser-metadata";
  const paths = ["challenges/sqli-demo", "battles/ac26-crypto-battle", "challenges/hello-world", "battles/hello-world-battle"];
  console.log(JSON.stringify(paths.map((path) => {
    const filename = process.cwd() + "/problems/" + path + "/metadata.json";
    const safe = publicMetadata(readFileSync(filename, "utf8"), filename);
    if (!safe) throw new Error("Missing host public projection");
    return JSON.parse(safe);
  })));
`,
    ],
    { cwd: resolve(process.cwd(), "../.."), encoding: "utf8" },
  ),
) as ProblemMetadata[];
const projected = publicProblems.map((metadata) => metadataToDetail(metadata));
const sqlMetadata = projected[0];
const sampleMetadata = projected[2];
const config: AppConfig = {
  mode: "local-host",
  cognitoDomain: "http://localhost/api/host",
  cognitoClientId: "local-host",
  redirectUri: "http://localhost/callback",
  scope: "",
  tenantId: "local-host",
  tenantName: "Local competition",
  apiBaseUrl: "http://localhost/api",
  samlIdpDirectory: {},
};
const supported = { items: [{ problemId: "sqli-demo" }, { problemId: "ac26-crypto-battle" }] };

function renderCatalog(path = "/problems") {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/problems" element={<LocalHostCatalogPage config={config} />} />
          <Route
            path="/problems/:problemId"
            element={<LocalHostCatalogPage config={config} detail />}
          />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
  get.mockReset().mockResolvedValue(supported);
});

describe("local catalog with production public metadata", () => {
  it("browses only runnable problems and opens safe projected details", async () => {
    const sql = projected[0];
    expect(sql.description).toBeUndefined();
    expect(sql.exposedPorts).toBeUndefined();
    expect(sql.learningGoals).toEqual([]);
    renderCatalog();
    fireEvent.click(await screen.findByRole("link", { name: sql.name }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: sql.name, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(sql.shortDescription)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Description" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Endpoints issued to participants" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Cost estimate" })).toBeNull();
    expect(get.mock.calls.every(([path]) => path === "host/catalog")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(await screen.findByRole("link", { name: sql.name })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: projected[1].name })).toBeInTheDocument();
    for (const sample of projected.slice(2))
      expect(screen.queryByRole("link", { name: sample.name })).toBeNull();
  });

  it("does not show an unsupported sample through a direct URL", async () => {
    renderCatalog("/problems/hello-world");
    expect(await screen.findByRole("heading", { name: "Problem not found" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: sampleMetadata.name })).toBeNull();
  });

  it("waits for the actual host catalog without briefly offering unsupported samples", async () => {
    let resolveCatalog!: (value: typeof supported) => void;
    get.mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    renderCatalog();
    await waitFor(() => expect(get).toHaveBeenCalledWith("host/catalog"));
    expect(screen.queryByRole("link", { name: sqlMetadata.name })).toBeNull();
    expect(screen.queryByText("No problems found")).toBeNull();
    resolveCatalog(supported);
    expect(await screen.findByRole("link", { name: sqlMetadata.name })).toBeInTheDocument();
  });

  it("reports an API failure instead of falling back to the build catalog", async () => {
    get.mockRejectedValue(new Error("Host catalog unavailable"));
    renderCatalog();
    expect(await screen.findByText("Host catalog unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: sqlMetadata.name })).toBeNull();
    expect(screen.queryByRole("link", { name: sampleMetadata.name })).toBeNull();
  });
});

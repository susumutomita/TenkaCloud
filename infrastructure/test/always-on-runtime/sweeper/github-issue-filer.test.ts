import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import { createGitHubIssueFiler } from "../../../lib/always-on-runtime/sweeper/github-issue-filer";

const FAILURE = {
  stackName: "tenkacloud-runtime-01JXYZ",
  attempts: 3,
  lastError: "delete timed out",
};

describe("createGitHubIssueFiler", () => {
  it("should POST an issue naming the stuck stack to the GitHub REST API", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: StatusCodes.CREATED }));
    const filer = createGitHubIssueFiler({
      repo: "susumutomita/TenkaCloud",
      token: "gh-token",
      labels: ["always-on-runtime"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await filer.openCleanupFailureIssue(FAILURE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/susumutomita/TenkaCloud/issues");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string);
    expect(payload.title).toContain(FAILURE.stackName);
    expect(payload.body).toContain(FAILURE.lastError);
    expect(payload.labels).toEqual(["always-on-runtime"]);
  });

  it("should fall back to the global fetch when no fetchImpl is injected", async () => {
    // Omitting fetchImpl exercises the `config.fetchImpl ?? fetch` default branch.
    const globalFetch = vi.fn(async () => new Response(null, { status: StatusCodes.CREATED }));
    vi.stubGlobal("fetch", globalFetch);
    try {
      const filer = createGitHubIssueFiler({
        repo: "susumutomita/TenkaCloud",
        token: "gh-token",
      });

      await filer.openCleanupFailureIssue(FAILURE);

      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [url] = globalFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/susumutomita/TenkaCloud/issues");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should throw when GitHub rejects the issue creation", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: StatusCodes.FORBIDDEN,
          statusText: "Forbidden",
        }),
    );
    const filer = createGitHubIssueFiler({
      repo: "susumutomita/TenkaCloud",
      token: "gh-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(filer.openCleanupFailureIssue(FAILURE)).rejects.toThrow(
      /failed to open cleanup-failure issue for stack tenkacloud-runtime-01JXYZ/,
    );
  });
});

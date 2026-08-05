import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWorkbenchConfig,
  getWorkbenchStarter,
  inspectWorkbench,
  prepareWorkbench,
  testWorkbench,
} from "../../src/api/portal-client";

const API = "http://127.0.0.1:3199";
const KEY = "AbCdEfGhIjKlMnOpQrStUvWx";

afterEach(() => vi.restoreAllMocks());

describe("container workbench Portal client", () => {
  it("should treat a 404 config probe as an unsupported capability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
    await expect(getWorkbenchConfig(API, KEY, "course/problem")).resolves.toBeUndefined();
  });

  it("should fetch starter files and inspect evidence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ "solution.py": "pass\n" }))
      .mockResolvedValueOnce(Response.json({ output: "seeded evidence" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWorkbenchStarter(API, KEY, "course/problem")).resolves.toEqual({
      "solution.py": "pass\n",
    });
    await expect(inspectWorkbench(API, KEY, "course/problem")).resolves.toEqual({
      output: "seeded evidence",
    });
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).pathname)).toEqual([
      "/portal/me/problems/course%2Fproblem/workbench/starter",
      "/portal/me/problems/course%2Fproblem/workbench/inspect",
    ]);
  });

  it("should send edited files to the encoded test route with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ passed: true, output: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const files = { "solution.py": "pass\n" };
    await expect(testWorkbench(API, KEY, "course/problem", files)).resolves.toEqual({
      passed: true,
      output: "ok",
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "http://127.0.0.1:3199/portal/me/problems/course%2Fproblem/workbench/test",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(init.body).toBe(JSON.stringify({ files }));
  });

  it("should prepare files and direct answers together", async () => {
    const payload = { ok: true, submissions: { implement: "tcw1.payload.signature" } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const files = { "solution.py": "pass\n" };
    const manual = { explain: "42" };
    await expect(prepareWorkbench(API, KEY, "course", files, manual)).resolves.toEqual(payload);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.body).toBe(JSON.stringify({ files, manual }));
  });
});

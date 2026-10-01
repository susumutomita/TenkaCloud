import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkbenchDraft, saveWorkbenchDraft, workbenchDraftKey } from "./workbench-drafts";

const API = "https://host.example.test/api";
const KEY = workbenchDraftKey(API, "job-a", "problem-a") as string;
const STARTER = { "solution.py": "pass\n", "helper.py": "" };

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("workbench draft storage", () => {
  it("normalizes only equivalent API bases and separates jobs, problems, ports, and paths", () => {
    expect(workbenchDraftKey(`${API}/`, "job-a", "problem-a")).toBe(KEY);
    expect(workbenchDraftKey(API, "job-b", "problem-a")).not.toBe(KEY);
    expect(workbenchDraftKey(API, "job-a", "problem-b")).not.toBe(KEY);
    expect(workbenchDraftKey("https://host.example.test:4000/api", "job-a", "problem-a")).not.toBe(
      KEY,
    );
    expect(workbenchDraftKey("https://host.example.test/other-api", "job-a", "problem-a")).not.toBe(
      KEY,
    );
    expect(workbenchDraftKey("/api", "job-a", "problem-a")).toContain(window.location.origin);
  });

  it.each([undefined, "", "   "])("has no problem-only fallback without a job: %s", (jobId) => {
    expect(workbenchDraftKey(API, jobId, "problem-a")).toBeUndefined();
    expect(readWorkbenchDraft(undefined, STARTER)).toEqual({ files: STARTER, issue: "unscoped" });
    expect(saveWorkbenchDraft(undefined, STARTER)).toBe("unscoped");
    expect(window.localStorage.length).toBe(0);
  });

  it.each([
    "https://user:synthetic-key@host.example.test/api",
    `${API}?key=synthetic-key`,
    `${API}#synthetic-key`,
    "file:///tmp/api",
    "https://[broken",
  ])("refuses unsafe API scopes rather than persisting credentials: %s", (api) => {
    expect(workbenchDraftKey(api, "job-a", "problem-a")).toBeUndefined();
  });

  it("does not create a record for an untouched starter and round-trips multiple edited files", () => {
    expect(readWorkbenchDraft(KEY, STARTER)).toEqual({ files: STARTER });
    expect(window.localStorage.length).toBe(0);
    const edited = { "solution.py": "解答 = 42\n", "helper.py": "" };
    expect(saveWorkbenchDraft(KEY, edited)).toBeUndefined();
    expect(readWorkbenchDraft(KEY, STARTER)).toEqual({ files: edited });
    expect(Object.keys(JSON.parse(window.localStorage.getItem(KEY) as string))).toEqual([
      "version",
      "files",
    ]);
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    JSON.stringify({ version: 2, files: STARTER }),
    JSON.stringify({ version: 1, files: [] }),
    JSON.stringify({ version: 1, files: { "solution.py": 42, "helper.py": "" } }),
    JSON.stringify({ version: 1, files: { "solution.py": "missing helper" } }),
    JSON.stringify({ version: 1, files: { ...STARTER, "extra.py": "unexpected" } }),
  ])("rejects incompatible/corrupt records without changing them: %s", (raw) => {
    window.localStorage.setItem(KEY, raw);
    expect(readWorkbenchDraft(KEY, STARTER)).toEqual({ files: STARTER, issue: "restore_failed" });
    expect(window.localStorage.getItem(KEY)).toBe(raw);
  });

  it("bounds UTF-8 draft size without discarding the previous saved version", () => {
    saveWorkbenchDraft(KEY, STARTER);
    const oversized = { ...STARTER, "solution.py": "字".repeat(400_000) };
    expect(saveWorkbenchDraft(KEY, oversized)).toBe("save_failed");
    expect(readWorkbenchDraft(KEY, STARTER)).toEqual({ files: STARTER });
    const raw = JSON.stringify({ version: 1, files: oversized });
    window.localStorage.setItem(KEY, raw);
    expect(readWorkbenchDraft(KEY, STARTER).issue).toBe("restore_failed");
    expect(window.localStorage.getItem(KEY)).toBe(raw);
  });

  it("reports storage access failures without throwing or deleting records", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
    expect(readWorkbenchDraft(KEY, STARTER)).toEqual({ files: STARTER, issue: "restore_failed" });
    expect(saveWorkbenchDraft(KEY, STARTER)).toBe("save_failed");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  requestWorkbench,
  type WorkbenchClientError,
} from "../../../scripts/local-play/workbench-client";

const CONFIG = {
  id: "course-problem",
  name: "Course problem",
  description: "Edit and test the starter.",
  submittedFiles: ["solution.py"],
  checkpoints: [{ id: "implement", label: "Implement", kind: "code" }],
};

describe("local-play workbench client", () => {
  it("should derive an allowlisted API URL from the loopback verify origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(CONFIG));
    await expect(
      requestWorkbench("http://127.0.0.1:18181/verify", "config", undefined, { fetchImpl }),
    ).resolves.toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:18181/api/config"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("should post only JSON to test and validate its response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ passed: false, output: "one public test failed" }),
    );
    const body = { files: { "solution.py": "pass\n" } };
    await expect(
      requestWorkbench("http://localhost:18181/verify", "test", body, { fetchImpl }),
    ).resolves.toEqual({ passed: false, output: "one public test failed" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://localhost:18181/api/test"),
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
  });

  it("should normalize legacy structured inspect evidence for the Portal", async () => {
    const evidence = {
      environment: { python: "3.13.14", healthToken: "local-token" },
      firstBroken: { trace: [1, 7, 3] },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(evidence));

    await expect(
      requestWorkbench("http://127.0.0.1:18181/verify", "inspect", undefined, { fetchImpl }),
    ).resolves.toEqual({ output: JSON.stringify(evidence, null, 2) });
  });

  it("should refuse a non-loopback verifier before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      requestWorkbench("https://example.com/verify", "config", undefined, { fetchImpl }),
    ).rejects.toThrow("Refusing non-loopback verifyUrl");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should classify a missing contract separately from an invalid response", async () => {
    await expect(
      requestWorkbench("http://127.0.0.1:18181/verify", "config", undefined, {
        fetchImpl: async () => new Response("missing", { status: 404 }),
      }),
    ).rejects.toMatchObject<Partial<WorkbenchClientError>>({ code: "not_supported" });
    await expect(
      requestWorkbench("http://127.0.0.1:18181/verify", "config", undefined, {
        fetchImpl: async () => Response.json({ id: "course-problem" }),
      }),
    ).rejects.toMatchObject<Partial<WorkbenchClientError>>({ code: "invalid_response" });
  });
});

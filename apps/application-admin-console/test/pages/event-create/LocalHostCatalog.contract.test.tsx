import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ApiClient } from "../../../src/api/client";
import { useHostCatalog } from "../../../src/pages/event-create/LocalHostEventCreate";

it("uses the authenticated catalog's coordination runtime and preserves optional organizer content", async () => {
  const content = { description: "説明", learningGoals: ["証拠を調べる"] };
  const api = {
    get: vi.fn().mockResolvedValue({
      items: [
        { problemId: "duel", runtime: "coordination", content },
        { problemId: "compose", runtime: "compose" },
        { problemId: "aws", runtime: "cloudformation" },
      ],
      limits: { maxTeams: 2, maxEventJobs: 4 },
    }),
  };
  const { result } = renderHook(() => useHostCatalog(api as unknown as ApiClient));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect([...(result.current.coordination ?? [])]).toEqual(["duel"]);
  expect([...result.current.cloud]).toEqual(["aws"]);
  expect(result.current.supported).toEqual(new Set(["duel", "compose", "aws"]));
  expect(result.current.content?.get("duel")).toEqual(content);
  expect(result.current.content?.has("compose")).toBe(false);
  expect(result.current.limits.maxTeams).toBe(2);
});

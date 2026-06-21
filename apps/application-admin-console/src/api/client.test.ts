import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ tokens: null }) }));

import { useApiClient } from "./client";
import type { EventListResponse } from "./events-client";

const demoConfig = { mode: "demo", apiBaseUrl: "https://demo.invalid" } as AppConfig;

describe("useApiClient demo mode (#1954)", () => {
  it("should return the fixture demo client when config.mode is demo (even without tokens)", async () => {
    const { result } = renderHook(() => useApiClient(demoConfig));
    expect(result.current).not.toBeNull();
    const res = await result.current?.get<EventListResponse>("events");
    expect(res?.items.length).toBeGreaterThan(0);
  });
});

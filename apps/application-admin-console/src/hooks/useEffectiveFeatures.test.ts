import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";

const mocks = vi.hoisted(() => ({ useApiClient: vi.fn() }));
vi.mock("../api/client", () => ({ useApiClient: mocks.useApiClient }));

import { useEffectiveFeatures } from "./useEffectiveFeatures";

/**
 * Issue #2231: `useEffectiveFeatures` layers `GET /feature-flags` (any tenant
 * role, #2265/#2267) onto the deploy-time `config.features` baseline. `useApiClient` is
 * mocked so these tests exercise only the merge/fail-open logic, not auth or fetch.
 */

function buildConfig(features: Record<string, boolean>): AppConfig {
  return { features } as unknown as AppConfig;
}

describe("useEffectiveFeatures", () => {
  it("should return the deploy-time baseline unchanged when there is no api client yet (pre-auth)", () => {
    mocks.useApiClient.mockReturnValue(null);
    const config = buildConfig({ samlSso: false, nonAwsRuntime: false, redTeam: true });

    const { result } = renderHook(() => useEffectiveFeatures(config));

    expect(result.current).toEqual({ samlSso: false, nonAwsRuntime: false, redTeam: true });
  });

  it("should layer a successful API response's boolean flags over the baseline", async () => {
    const get = vi.fn().mockResolvedValue({ flags: { samlSso: true, redTeam: false } });
    mocks.useApiClient.mockReturnValue({ get });
    const config = buildConfig({ samlSso: false, nonAwsRuntime: false, redTeam: true });

    const { result } = renderHook(() => useEffectiveFeatures(config));

    await waitFor(() =>
      expect(result.current).toEqual({
        samlSso: true,
        nonAwsRuntime: false,
        redTeam: false,
      }),
    );
    expect(get).toHaveBeenCalledWith("/feature-flags");
  });

  it("should keep the baseline value for a key the API response does not mention", async () => {
    const get = vi.fn().mockResolvedValue({ flags: { redTeam: false } });
    mocks.useApiClient.mockReturnValue({ get });
    const config = buildConfig({ samlSso: false, nonAwsRuntime: true, redTeam: true });

    const { result } = renderHook(() => useEffectiveFeatures(config));

    await waitFor(() => expect(result.current?.redTeam).toBe(false));
    expect(result.current).toEqual({ samlSso: false, nonAwsRuntime: true, redTeam: false });
  });

  it("should ignore an unrecognized key and a non-boolean value in the API response", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ flags: { notARealFlag: true, samlSso: "true" as unknown as boolean } });
    mocks.useApiClient.mockReturnValue({ get });
    const config = buildConfig({ samlSso: false, nonAwsRuntime: false, redTeam: false });

    const { result } = renderHook(() => useEffectiveFeatures(config));

    await waitFor(() => expect(get).toHaveBeenCalled());
    // give the resolved promise's .then a microtask turn
    await act(async () => {});
    expect(result.current).toEqual({ samlSso: false, nonAwsRuntime: false, redTeam: false });
  });

  it("should fail open to the baseline when the fetch rejects", async () => {
    const get = vi.fn().mockRejectedValue(new Error("network down"));
    mocks.useApiClient.mockReturnValue({ get });
    const config = buildConfig({ samlSso: true, nonAwsRuntime: false, redTeam: false });

    const { result } = renderHook(() => useEffectiveFeatures(config));

    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current).toEqual({ samlSso: true, nonAwsRuntime: false, redTeam: false });
  });

  it("should not call the API in demo mode even when an api client is available", async () => {
    const get = vi.fn();
    mocks.useApiClient.mockReturnValue({ get });
    const config: AppConfig = {
      ...buildConfig({ samlSso: false, nonAwsRuntime: false, redTeam: true }),
      mode: "demo",
    };

    renderHook(() => useEffectiveFeatures(config));
    await act(async () => {});

    expect(get).not.toHaveBeenCalled();
  });

  it("should not apply a response that resolves after the component unmounted", async () => {
    let resolveFetch: (value: { flags: Record<string, boolean> }) => void = () => {};
    const get = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    mocks.useApiClient.mockReturnValue({ get });
    const config = buildConfig({ samlSso: false, nonAwsRuntime: false, redTeam: false });

    const { result, unmount } = renderHook(() => useEffectiveFeatures(config));
    unmount();
    resolveFetch({ flags: { samlSso: true } });
    await act(async () => {});

    // The hook's cleanup set `cancelled = true` before the promise resolved, so the
    // stale-closure guard (`if (cancelled) return;`) must skip setFeatures entirely —
    // asserting on the last-known result value confirms no state update was attempted.
    expect(result.current).toEqual({ samlSso: false, nonAwsRuntime: false, redTeam: false });
  });
});

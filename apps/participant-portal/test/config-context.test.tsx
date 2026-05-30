import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import { AppConfigProvider, useAppConfig, useIsMock } from "../src/config-context";

/**
 * AppConfig context: provider 内で config を返す / provider 外で throw / useIsMock の
 * mode !== "backend" 派生を pin する。
 */
const cfg = (mode: string) => ({ mode }) as AppConfig;
const wrapWith = (config: AppConfig) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <AppConfigProvider config={config}>{children}</AppConfigProvider>;
  };

describe("config-context", () => {
  it("should return the config from inside the provider", () => {
    const config = cfg("backend");
    const { result } = renderHook(() => useAppConfig(), { wrapper: wrapWith(config) });
    expect(result.current).toBe(config);
  });

  it("should throw when useAppConfig is called outside the provider", () => {
    expect(() => renderHook(() => useAppConfig())).toThrow(/AppConfigProvider/);
  });

  it("should derive useIsMock from mode !== backend", () => {
    expect(
      renderHook(() => useIsMock(), { wrapper: wrapWith(cfg("backend")) }).result.current,
    ).toBe(false);
    expect(
      renderHook(() => useIsMock(), { wrapper: wrapWith(cfg("dev-mock")) }).result.current,
    ).toBe(true);
  });
});

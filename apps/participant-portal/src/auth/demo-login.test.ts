import { describe, expect, it } from "vitest";
import { isDemoAutoLoginRequested } from "./demo-login";

describe("isDemoAutoLoginRequested (#2707)", () => {
  it("should request demo auto-login only when dev-mock mode sees ?demo=1", () => {
    expect(isDemoAutoLoginRequested("dev-mock", "?demo=1")).toBe(true);
    expect(isDemoAutoLoginRequested("dev-mock", "?foo=bar&demo=1")).toBe(true);
  });

  it("should never trigger in backend mode even with ?demo=1", () => {
    expect(isDemoAutoLoginRequested("backend", "?demo=1")).toBe(false);
  });

  it("should ignore missing or non-1 demo params", () => {
    expect(isDemoAutoLoginRequested("dev-mock", "")).toBe(false);
    expect(isDemoAutoLoginRequested("dev-mock", "?demo=0")).toBe(false);
    expect(isDemoAutoLoginRequested("dev-mock", "?demo=true")).toBe(false);
  });
});

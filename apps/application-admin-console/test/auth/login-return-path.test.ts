import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLoginReturnPath,
  consumeLoginReturnPath,
  readLoginReturnPathState,
  rememberLoginReturnPath,
} from "../../src/auth/login-return-path";

const KEY = "TenkaCloud.application_admin.login_return_path";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("login return path", () => {
  it("should preserve a same-app deep link with its query and hash", () => {
    const path = buildLoginReturnPath({
      pathname: "/deployments/job-1",
      search: "?view=logs",
      hash: "#latest",
    });
    expect(path).toBe("/deployments/job-1?view=logs#latest");
    expect(readLoginReturnPathState({ returnPath: path })).toBe(path);
  });

  it("should fall back to home when the current location is not a safe deep link", () => {
    // sanitize が undefined を返す location は `?? DEFAULT_RETURN_PATH` で home に倒す (line 13 の枝)。
    expect(buildLoginReturnPath({ pathname: "/login", search: "", hash: "" })).toBe("/");
  });

  it("should consume the remembered path exactly once", () => {
    rememberLoginReturnPath("/deployments/job-1");
    expect(consumeLoginReturnPath()).toBe("/deployments/job-1");
    expect(consumeLoginReturnPath()).toBe("/");
  });

  it("should reject external, protocol-relative, and auth-loop paths", () => {
    for (const path of [
      "https://attacker.example/",
      "//attacker.example/",
      "/login",
      "/callback?code=stale",
    ]) {
      sessionStorage.setItem(KEY, path);
      expect(consumeLoginReturnPath()).toBe("/");
    }
  });

  it("should clear an old remembered path when login starts without a deep link", () => {
    sessionStorage.setItem(KEY, "/deployments/stale");
    rememberLoginReturnPath(undefined);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("should fall back to home when sessionStorage is unavailable", () => {
    // privacy-restricted ブラウザ等で getItem が throw する catch 経路 (= home へフォールバック)。
    // Stub the global object itself. Bun on macOS can expose a different `Storage.prototype`,
    // which made a prototype spy pass without exercising the catch branch.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
      removeItem: vi.fn(),
    });
    expect(consumeLoginReturnPath()).toBe("/");
  });
});

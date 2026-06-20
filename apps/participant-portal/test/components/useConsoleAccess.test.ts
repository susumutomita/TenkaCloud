import { describe, expect, it } from "vitest";
import {
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../../src/api/portal-client";
import { describeOpenConsoleError } from "../../src/components/useConsoleAccess";

/**
 * describeOpenConsoleError: AWS Console を開く際の error → 表示文字列 / logout シグナルへの
 * 変換を pin する。 SsoCredentials ページと TopNavigation 常設導線 (Issue #1919) が共有する
 * 純粋関数なので、 各 error 種別の分岐を直接テストする。
 */
const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}|${JSON.stringify(vars)}` : key;

describe("describeOpenConsoleError", () => {
  it("should signal a logout on an auth error", () => {
    expect(describeOpenConsoleError(new PortalAuthError(), t)).toBe("auth_logout");
  });

  it("should render a stage-aware message on an assume-role error", () => {
    const message = describeOpenConsoleError(
      new PortalAssumeRoleError("participant_viewer", "denied"),
      t,
    );
    expect(message).toContain("sso_credentials.cli.assume_role_failed");
    expect(message).toContain("sso_credentials.cli.stage_participant_viewer");
    expect(message).toContain("denied");
  });

  it("should render a validation message with the error code", () => {
    const message = describeOpenConsoleError(new PortalValidationError("bad_input"), t);
    expect(message).toContain("sso_credentials.validation_error");
    expect(message).toContain("bad_input");
  });

  it("should stringify a generic Error", () => {
    expect(describeOpenConsoleError(new Error("network down"), t)).toBe("network down");
  });

  it("should stringify a non-Error rejection", () => {
    expect(describeOpenConsoleError("plain failure", t)).toBe("plain failure");
  });
});

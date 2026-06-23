import { describe, expect, it } from "vitest";
import {
  buildInkManagedLoginAssets,
  buildInkManagedLoginSettings,
} from "../../lib/shared/managed-login-branding";

/**
 * Cognito Managed login の settings / assets は schema が厳格で、 無効キーは synth では通り
 * deploy 時にだけ HTTP 400 (UpdateFailed) になる。 実 deploy で踏んだ 2 件を回帰ガードする:
 *   - components.inputDescription は UnknownProperty (= componentClasses 配下が正)
 *   - FORM_LOGO asset の resourceId は "not supported for asset category 'FORM_LOGO'"
 */
describe("managed-login-branding — Cognito schema guards", () => {
  it("should place inputDescription under componentClasses, not components", () => {
    const settings = buildInkManagedLoginSettings() as {
      componentClasses?: Record<string, unknown>;
      components?: Record<string, unknown>;
    };
    expect(settings.componentClasses?.inputDescription).toBeDefined();
    expect(settings.components?.inputDescription).toBeUndefined();
  });

  it("should omit resourceId on the FORM_LOGO asset", () => {
    const formLogo = buildInkManagedLoginAssets().find((a) => a.category === "FORM_LOGO");
    expect(formLogo).toBeDefined();
    expect((formLogo as { resourceId?: string }).resourceId).toBeUndefined();
  });
});

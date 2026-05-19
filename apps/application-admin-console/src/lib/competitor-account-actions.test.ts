import { describe, expect, it } from "vitest";
import {
  evaluateRotateButtonGuard,
  ROTATE_DISABLED_REASON_NOT_VERIFIED,
  ROTATE_DISABLED_REASON_VERIFY_IN_FLIGHT,
} from "./competitor-account-actions";

/**
 * Issue #1054: Competitor Accounts 画面の Rotate ExternalId button guard を pin する。
 * backend (#868) の 409 not_verified guard と UI が乖離しないよう、 不変条件を test で固定する。
 */
describe("evaluateRotateButtonGuard (Issue #1054)", () => {
  it("verified=false の row では Rotate ExternalId button が disabled であるべき", () => {
    const result = evaluateRotateButtonGuard({ verified: false, verifyInFlight: null });
    expect(result.disabled).toBe(true);
    expect(result.reason).toBe(ROTATE_DISABLED_REASON_NOT_VERIFIED);
  });

  it("verified=true の row では Rotate ExternalId button が enabled であるべき", () => {
    const result = evaluateRotateButtonGuard({ verified: true, verifyInFlight: null });
    expect(result.disabled).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("verifyInFlight が進行中は verified=true でも Rotate button が disabled であるべき", () => {
    const result = evaluateRotateButtonGuard({
      verified: true,
      verifyInFlight: "123456789012",
    });
    expect(result.disabled).toBe(true);
    expect(result.reason).toBe(ROTATE_DISABLED_REASON_VERIFY_IN_FLIGHT);
  });

  it("not_verified と verify in-flight が同時に成立するときは not_verified を優先して説明すべき", () => {
    // operator が unverified row を verify 中に他 row の rotate を試した経路。
    // 「先に Verify を成功させて」 の方が本質的な原因なのでそちらを表示する。
    const result = evaluateRotateButtonGuard({
      verified: false,
      verifyInFlight: "123456789012",
    });
    expect(result.disabled).toBe(true);
    expect(result.reason).toBe(ROTATE_DISABLED_REASON_NOT_VERIFIED);
  });
});

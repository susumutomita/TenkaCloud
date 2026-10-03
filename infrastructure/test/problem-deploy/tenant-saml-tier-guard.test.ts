import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import {
  pooledTierSamlBlock,
  routeDelete,
  routePut,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-routes";

/**
 * #1385: pooled tier は UserPool + UserPoolClient を全 pooled tenant で共有するため、
 * SAML config mutation を silo (PLATINUM) / Lite のみに制限する。 tenantTier claim は
 * server-set + 署名検証済みなので詐称不能。 claim 不在は許可側 (silo/Lite)。
 *
 * Regression guard: 旧実装は pooled tier の deny-list ({BASIC, STANDARD, PREMIUM}) で、
 * tier リネーム (#55 で premium→platinum、 製品 tier は basic/advanced/platinum) により
 * ADVANCED (pooled) がガードをすり抜けて共有 UserPool を mutate できた。 現実装は
 * fail-closed (= claim があり PLATINUM 以外なら全て block) なので、 将来の tier 追加 /
 * リネームでもガードは開かない。
 */
function ctxWithTier(tier?: string): Context {
  return {
    env: {
      event: {
        requestContext: {
          authorizer: { jwt: { claims: tier ? { "custom:tenantTier": tier } : {} } },
        },
      },
    },
  } as unknown as Context;
}

describe("pooledTierSamlBlock (#1385)", () => {
  it.each([
    "BASIC",
    "STANDARD",
    "PREMIUM",
    "basic",
    "Premium",
    // 製品の pooled tier (tenants.ts の Tier 型)。旧 deny-list はこれをすり抜けていた。
    "ADVANCED",
    "advanced",
    // 未知の tier 値も fail-closed で block する (= 将来のリネームでガードが開かない)。
    "GOLD",
  ])("should block SAML config mutation for non-silo tier %s (shared UserPool)", (tier) => {
    const block = pooledTierSamlBlock(ctxWithTier(tier));
    expect(block?.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect((block?.body as { error?: string })?.error).toBe("tenant_tier_not_silo");
  });

  it("should allow PLATINUM (silo, dedicated UserPool)", () => {
    expect(pooledTierSamlBlock(ctxWithTier("PLATINUM"))).toBeUndefined();
  });

  it("should allow when the tenantTier claim is absent (silo / Lite / admin path)", () => {
    expect(pooledTierSamlBlock(ctxWithTier(undefined))).toBeUndefined();
  });
});

describe("routePut / routeDelete pooled-tier guard (#1385)", () => {
  it("routePut should 503 for a pooled tier without invoking Cognito self-targeting", async () => {
    const makeCognitoDeps = vi.fn();
    const res = await routePut({ shared: {} as never, makeCognitoDeps }, ctxWithTier("STANDARD"));
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect(makeCognitoDeps).not.toHaveBeenCalled();
  });

  it("routeDelete should 503 for a pooled tier without invoking Cognito self-targeting", async () => {
    const makeCognitoDeps = vi.fn();
    const res = await routeDelete({ shared: {} as never, makeCognitoDeps }, ctxWithTier("BASIC"));
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect(makeCognitoDeps).not.toHaveBeenCalled();
  });
});

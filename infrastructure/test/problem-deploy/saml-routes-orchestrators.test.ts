import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMakeCognitoDeps,
  extractSelfPoolFromContext,
  routeDelete,
  routeGet,
  routePut,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-routes";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1424: SAML route orchestrators (routeGet / routePut / routeDelete) + Cognito-deps
 * 解決 helper (extractSelfPoolFromContext / defaultMakeCognitoDeps) を pin する。 既存
 * tenant-saml.test は handle* を直接、 tenant-saml-tier-guard.test は pooled-tier 503 を見るが、
 * orchestrator の missing-claims(422) / invalid-body(400) / iss-aud からの self-pool 解決 / GET 委譲 /
 * DELETE 委譲が未カバーで 38% branch だった。
 */
const VALID_ISS = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_ABC123";

// extractClaims は c.env.event.requestContext.authorizer.jwt.claims を読む (tenant-saml-tier-guard と同形)。
const ctx = (opts: {
  claims?: Record<string, unknown>;
  body?: unknown;
  bodyThrows?: boolean;
}): Context =>
  ({
    env: {
      event: {
        requestContext: { authorizer: { jwt: { claims: opts.claims ?? {} } } },
      },
    },
    req: {
      json: opts.bodyThrows ? () => Promise.reject(new Error("bad body")) : async () => opts.body,
    },
  }) as unknown as Context;

const shared = {
  runtime: makeTestControlDataRuntime(),
  ddb: { send: vi.fn().mockResolvedValue({}) },
  cognito: { send: vi.fn().mockResolvedValue({ UserPoolClient: {} }) },
  tableName: "TestCompetitorAccounts",
  env: "development",
} as unknown as CompetitorAccountsSharedResources;

beforeEach(() => {
  vi.clearAllMocks();
  shared.ddb.send = vi.fn().mockResolvedValue({});
  shared.cognito.send = vi.fn().mockResolvedValue({ UserPoolClient: {} });
  process.env.DEFAULT_TENANT_ID = "tenant-test";
});
afterEach(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  vi.clearAllMocks();
});

describe("extractSelfPoolFromContext", () => {
  it("should resolve userPoolId + clientId from iss + aud", async () => {
    const out = extractSelfPoolFromContext(ctx({ claims: { iss: VALID_ISS, aud: "client-1" } }));
    expect(out).toMatchObject({
      userPoolId: "ap-northeast-1_ABC123",
      userPoolClientId: "client-1",
    });
    // The skeleton's client.send is a placeholder that callers (defaultMakeCognitoDeps) override
    // with shared.cognito; invoke it directly to pin the "not injected" guard.
    await expect(out?.client.send({} as never)).rejects.toThrow(/client not injected/);
  });

  it("should fall back to client_id when aud is absent", () => {
    const out = extractSelfPoolFromContext(
      ctx({ claims: { iss: VALID_ISS, client_id: "client-2" } }),
    );
    expect(out?.userPoolClientId).toBe("client-2");
  });

  it("should return undefined when iss is not a Cognito issuer", () => {
    expect(
      extractSelfPoolFromContext(ctx({ claims: { iss: "https://evil", aud: "x" } })),
    ).toBeUndefined();
  });

  it("should return undefined when neither aud nor client_id is present", () => {
    expect(extractSelfPoolFromContext(ctx({ claims: { iss: VALID_ISS } }))).toBeUndefined();
  });
});

describe("defaultMakeCognitoDeps", () => {
  it("should build deps from the self pool, using shared.cognito as the client", () => {
    const deps = defaultMakeCognitoDeps(shared)(ctx({ claims: { iss: VALID_ISS, aud: "c" } }));
    expect(deps).toMatchObject({ client: shared.cognito, userPoolId: "ap-northeast-1_ABC123" });
  });

  it("should return undefined when the context has no self pool", () => {
    expect(defaultMakeCognitoDeps(shared)(ctx({ claims: {} }))).toBeUndefined();
  });
});

describe("routeGet", () => {
  it("should resolve the tenant and return the SAML config (disabled when absent)", async () => {
    const res = await routeGet({ shared }, ctx({ claims: {} }));
    expect(res.status).toBe(StatusCodes.OK);
    expect(res.body).toEqual({ enabled: false });
  });
});

describe("routePut", () => {
  it("should 422 when Cognito deps cannot be resolved", async () => {
    const res = await routePut({ shared, makeCognitoDeps: () => undefined }, ctx({ claims: {} }));
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect((res.body as { error: string }).error).toBe("missing_cognito_claims");
  });

  it("should 400 invalid_body when the JSON body cannot be parsed", async () => {
    const res = await routePut(
      {
        shared,
        makeCognitoDeps: () => ({ client: shared.cognito, userPoolId: "p", userPoolClientId: "c" }),
      },
      ctx({ claims: {}, bodyThrows: true }),
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((res.body as { error: string }).error).toBe("invalid_body");
  });

  it("should delegate to handlePut (which 400s on an insecure metadataUrl)", async () => {
    const res = await routePut(
      {
        shared,
        makeCognitoDeps: () => ({ client: shared.cognito, userPoolId: "p", userPoolClientId: "c" }),
      },
      ctx({ claims: {}, body: { metadataUrl: "http://insecure" } }),
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should resolve deps via defaultMakeCognitoDeps when none are injected (iss+aud present)", async () => {
    const res = await routePut(
      { shared }, // no makeCognitoDeps → defaultMakeCognitoDeps path
      ctx({
        claims: { iss: VALID_ISS, aud: "client-1" },
        body: { metadataUrl: "http://insecure" },
      }),
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST); // handlePut rejects the insecure URL
  });

  it("should 422 via defaultMakeCognitoDeps when the context lacks iss/aud", async () => {
    const res = await routePut({ shared }, ctx({ claims: {}, body: {} }));
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
  });
});

describe("routeDelete", () => {
  it("should 422 when Cognito deps cannot be resolved", async () => {
    const res = await routeDelete(
      { shared, makeCognitoDeps: () => undefined },
      ctx({ claims: {} }),
    );
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
  });

  it("should delegate to handleDelete and return deleted:true", async () => {
    const res = await routeDelete(
      {
        shared,
        makeCognitoDeps: () => ({
          client: { send: vi.fn().mockResolvedValue({ UserPoolClient: {} }) },
          userPoolId: "ap-northeast-1_ABC123",
          userPoolClientId: "client-1",
        }),
      },
      ctx({ claims: {} }),
    );
    expect(res.status).toBe(StatusCodes.OK);
    expect(res.body).toEqual({ deleted: true });
  });
});

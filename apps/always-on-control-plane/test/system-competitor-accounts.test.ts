import { env } from "cloudflare:workers";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const SYSTEM_TOKEN = "system-admin-token-0123456789abcdef";
const envWithToken = { ...env, SYSTEM_ADMIN_TOKEN: SYSTEM_TOKEN };

const VALID_BODY = {
  competitorRoleArn: "arn:aws:iam::111111111111:role/TenkaCloud-tenant-acme-deploy-Role",
  externalIdParameterName: "/dev/tenants/tenant-acme/external-id",
};

async function put(
  tenantId: string,
  awsAccountId: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return await createApp().request(
    `https://control.example/v1/system/competitor-accounts/${tenantId}/${awsAccountId}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    envWithToken,
  );
}

async function row(tenantId: string, awsAccountId: string) {
  return env.CONTROL_DB.prepare(
    `SELECT competitor_role_arn, external_id_parameter_name
       FROM competitor_account_projection
      WHERE tenant_id = ? AND aws_account_id = ?`,
  )
    .bind(tenantId, awsAccountId)
    .first<{ competitor_role_arn: string; external_id_parameter_name: string }>();
}

beforeEach(async () => {
  await env.CONTROL_DB.exec("DELETE FROM competitor_account_projection;");
});

describe("PUT /v1/system/competitor-accounts/:tenantId/:awsAccountId", () => {
  it("should register the tenant-owned account with a valid system-admin bearer", async () => {
    const res = await put("tenant-acme", "111111111111", VALID_BODY, SYSTEM_TOKEN);
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    expect(await row("tenant-acme", "111111111111")).toEqual({
      competitor_role_arn: VALID_BODY.competitorRoleArn,
      external_id_parameter_name: VALID_BODY.externalIdParameterName,
    });
  });

  it("should update an existing registration in place", async () => {
    await put("tenant-acme", "111111111111", VALID_BODY, SYSTEM_TOKEN);
    const res = await put(
      "tenant-acme",
      "111111111111",
      { ...VALID_BODY, externalIdParameterName: "/prod/tenants/tenant-acme/external-id" },
      SYSTEM_TOKEN,
    );
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    expect((await row("tenant-acme", "111111111111"))?.external_id_parameter_name).toBe(
      "/prod/tenants/tenant-acme/external-id",
    );
  });

  it("should reject a missing bearer", async () => {
    const res = await put("tenant-acme", "111111111111", VALID_BODY);
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(await row("tenant-acme", "111111111111")).toBeNull();
  });

  it("should reject a non-12-digit account id", async () => {
    const res = await put("tenant-acme", "not-an-account", VALID_BODY, SYSTEM_TOKEN);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should reject a whitespace-only tenantId", async () => {
    const res = await put("%20", "111111111111", VALID_BODY, SYSTEM_TOKEN);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should reject a non-IAM-role ARN", async () => {
    const res = await put(
      "tenant-acme",
      "111111111111",
      { ...VALID_BODY, competitorRoleArn: "arn:aws:s3:::not-a-role" },
      SYSTEM_TOKEN,
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should reject a parameter name without a leading slash", async () => {
    const res = await put(
      "tenant-acme",
      "111111111111",
      { ...VALID_BODY, externalIdParameterName: "no-leading-slash" },
      SYSTEM_TOKEN,
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should reject unknown extra fields (strict body)", async () => {
    const res = await put(
      "tenant-acme",
      "111111111111",
      { ...VALID_BODY, externalId: "the-secret-itself" },
      SYSTEM_TOKEN,
    );
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });
});

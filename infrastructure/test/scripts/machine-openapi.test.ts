import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildMachineApiSpec,
  CAPABILITY_EXTENSION,
  findSecretMaterial,
  serializeSpec,
} from "../../../scripts/openapi/machine-api-spec";
import { UnsupportedZodTypeError, zodToJsonSchema } from "../../../scripts/openapi/zod-json-schema";
import {
  capabilityScope,
  MACHINE_ROUTE_SCOPES,
} from "../../lib/problem-deploy/handlers/shared/machine-scopes";

/**
 * Issue #2949: machine API surface の OpenAPI spec は source of truth から生成される。
 *
 * この test が守るもの:
 *  - operation 集合が `MACHINE_ROUTE_SCOPES` と **完全一致** すること (drift 検出)
 *  - 各 operation が `security` と `x-tenkacloud-capability` を持つこと (ラベル欠落は fail)
 *  - `servers` の既定が production でないこと
 *  - spec に credential material が入らないこと。secret 検出器そのものが働くことを、
 *    わざと汚した spec で **落ちること** も含めて確認する (negative test)
 *  - commit 済み生成物が生成結果と一致すること
 */

const REPO_ROOT = resolve(__dirname, "../../..");

describe("#2949: generated spec matches the route source of truth", () => {
  const spec = buildMachineApiSpec();

  it("should contain exactly the allowlisted operations", () => {
    const generated = Object.entries(spec.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    const expected = MACHINE_ROUTE_SCOPES.map(
      (route) => `${route.method} ${route.apigwPath}`,
    ).sort();
    expect(generated).toEqual(expected);
  });

  it("should give every operation the scope its capability requires", () => {
    for (const route of MACHINE_ROUTE_SCOPES) {
      const operation = spec.paths[route.apigwPath]?.[route.method.toLowerCase()];
      expect(operation, `${route.method} ${route.apigwPath}`).toBeDefined();
      expect(operation?.security).toEqual([
        { TenkaCloudMachineOAuth: [capabilityScope(route.capability)] },
      ]);
    }
  });

  it("should label every operation with its capability (a missing label fails the build)", () => {
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation[CAPABILITY_EXTENSION]).toBeDefined();
        expect(["read", "deploy"]).toContain(operation[CAPABILITY_EXTENSION]);
      }
    }
  });

  it("should describe the deploy body from the handler's own zod schema", () => {
    const operation = spec.paths["/problems/{problemId}/deploy"]?.post;
    const schema = operation?.requestBody?.content["application/json"]?.schema;
    expect(schema?.required?.sort()).toEqual(["awsAccountId", "region", "teamName"]);
    // 手書きではなく zod の regex がそのまま落ちていることを確認する。
    expect(schema?.properties?.awsAccountId?.pattern).toBe("^\\d{12}$");
    expect(schema?.properties?.teamName?.maxLength).toBe(40);
    // 任意フィールドは required に入らない。
    expect(schema?.properties?.accountGroupId).toBeDefined();
    expect(schema?.required).not.toContain("accountGroupId");
  });

  it("should not default servers to a production host", () => {
    const server = spec.servers[0] as {
      url: string;
      variables?: Record<string, { default: string }>;
    };
    const fallback = server.variables?.machineApiBaseUrl?.default ?? server.url;
    expect(fallback).toContain("example.invalid");
    expect(fallback).not.toMatch(/amazonaws\.com|tenkacloud\.(com|dev|io)/);
  });

  it("should declare only the two Phase 1 scopes on the security scheme", () => {
    const schemes = spec.components.securitySchemes as Record<
      string,
      { flows: { clientCredentials: { scopes: Record<string, string> } } }
    >;
    expect(
      Object.keys(schemes.TenkaCloudMachineOAuth?.flows.clientCredentials.scopes ?? {}),
    ).toEqual([capabilityScope("read"), capabilityScope("deploy")]);
  });
});

describe("#2949: the spec never carries credential material", () => {
  it("should find nothing in the real spec", () => {
    expect(findSecretMaterial(serializeSpec(buildMachineApiSpec()))).toEqual([]);
  });

  // negative test: 検出器が本当に効いているかを、わざと汚した入力で確認する。これが無いと
  // 「常に空配列を返す検出器」でも上の test は通ってしまう。
  it.each([
    ["a bearer token", '{"example":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}'],
    ["a raw JWT", '{"token":"eyJraWQiOiJhYmNkZWZnaGlqa2xtbm9wIn0.payload.sig"}'],
    ["a client secret", '{"client_secret":"1h7v9qk2p0abcdefg"}'],
    ["an AWS access key id", '{"key":"AKIAIOSFODNN7EXAMPLE"}'],
  ])("should flag %s", (_label, serialized) => {
    expect(findSecretMaterial(serialized).length).toBeGreaterThan(0);
  });

  it("should refuse to serialize a spec that carries a secret", () => {
    const poisoned = buildMachineApiSpec();
    const withSecret = {
      ...poisoned,
      info: { ...poisoned.info, description: "example: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghij" },
    };
    expect(() => serializeSpec(withSecret)).toThrow(/credential material/);
  });
});

describe("#2949: the committed artifact is in sync", () => {
  it("should match the generator byte for byte", () => {
    const committed = readFileSync(resolve(REPO_ROOT, "docs/api/machine-api.openapi.json"), "utf8");
    expect(committed).toBe(serializeSpec(buildMachineApiSpec()));
  });
});

describe("#2949: the zod converter fails loudly on anything it does not understand", () => {
  it("should convert the constructs the handlers actually use", () => {
    const schema = z.object({
      name: z
        .string()
        .min(1)
        .max(4)
        .regex(/^[a-z]+$/),
      count: z.number().int().min(0),
      flag: z.boolean(),
      choice: z.enum(["a", "b"]),
      list: z.array(z.string()),
      maybe: z.string().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["name", "count", "flag", "choice", "list"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 4, pattern: "^[a-z]+$" },
        count: { type: "integer", minimum: 0 },
        flag: { type: "boolean" },
        choice: { type: "string", enum: ["a", "b"] },
        list: { type: "array", items: { type: "string" } },
        maybe: { type: "string" },
      },
    });
  });

  it("should throw rather than emit a permissive empty schema for an unsupported type", () => {
    // `{}` を返すと「何でも通る」嘘のドキュメントになるので、生成を止めるのが正しい。
    expect(() => zodToJsonSchema(z.object({ when: z.date() }))).toThrow(UnsupportedZodTypeError);
  });
});

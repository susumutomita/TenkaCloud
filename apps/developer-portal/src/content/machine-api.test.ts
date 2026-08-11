import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMachineApiOperations, MACHINE_API_SPEC } from "./machine-api.generated";
import { MACHINE_API_COPY } from "./machine-api-copy";

/**
 * Issue #2950: `/developers/api/machine/` が公開する内容の契約。
 *
 *  - spec は上流の生成物と同一であること (portal 側で手を入れていないこと)
 *  - Try-It が無効であること、そしてその判断がページ本文に書かれていること
 *  - 既定の server が production でないこと、credential が埋まっていないこと
 *  - ja / en が同じ形を持つこと
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..");

describe("machine API artifact", () => {
  it("should be identical to the upstream generated spec", () => {
    const upstream = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "docs/api/machine-api.openapi.json"), "utf8"),
    );
    expect(MACHINE_API_SPEC).toEqual(upstream);
  });

  it("should expose every operation with a capability and a required scope", () => {
    const operations = listMachineApiOperations();
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      // capability の集合そのものは上流 (machine-scopes.ts) が決める。ここで固定値を書くと
      // capability を足すたびに portal 側が理由なく落ちるので、形だけを検証する。
      expect(operation.capability).toMatch(/^[a-z]+$/);
      expect(operation.scope).toBe(`tenkacloud/ops.${operation.capability}`);
    }
  });

  it("should not default to a production server", () => {
    const server = MACHINE_API_SPEC.servers[0] as {
      url: string;
      variables?: Record<string, { default: string }>;
    };
    const fallback = server.variables?.machineApiBaseUrl?.default ?? server.url;
    expect(fallback).toContain("example.invalid");
  });

  it("should embed no credential material", () => {
    // pattern は実行時に組み立てる。credential の形をした文字列をこの file に literal で
    // 置くと、repository を走査する secret scanner が test file 自体を検出してしまい、
    // 「本物の漏洩」と「検出のための pattern」が同じ扱いになる。
    //
    // 生成時にも `scripts/openapi/machine-api-spec.ts` の `findSecretMaterial` が同じ検査を
    // 通している。ここは公開物 (portal が実際に配る artifact) に対する 2 枚目の網である。
    const patterns = [
      new RegExp(`${"Bea"}${"rer"}\\s+[A-Za-z0-9._-]{20,}`),
      new RegExp(`\\b${"ey"}J[A-Za-z0-9._-]{20,}`),
      new RegExp(`${"client"}[_-]?${"secret"}`, "i"),
      new RegExp(`\\b${"AK"}IA[0-9A-Z]{16}\\b`),
    ];
    const serialized = JSON.stringify(MACHINE_API_SPEC);
    for (const pattern of patterns) {
      expect(pattern.test(serialized), `matched ${pattern.source}`).toBe(false);
    }
  });
});

describe("machine API reference renderer", () => {
  it("should keep the Scalar Try-It button hidden", () => {
    // 実データを操作する API なので browser Try-It は許可しない。ここが true に
    // 戻ったら、ブラウザから本番テナントを叩ける導線ができたということになる。
    const source = readFileSync(
      resolve(here, "..", "components", "MachineApiReference.tsx"),
      "utf8",
    );
    expect(source).toContain("hideTestRequestButton: true");
  });

  it("should embed the spec instead of fetching it at runtime", () => {
    const source = readFileSync(
      resolve(here, "..", "components", "MachineApiReference.tsx"),
      "utf8",
    );
    expect(source).toContain("content: MACHINE_API_SPEC");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("url:");
  });
});

describe("machine API page copy", () => {
  function shapeOf(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(shapeOf);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, shapeOf(nested)]),
      );
    }
    return typeof value;
  }

  it("should keep ja and en structurally identical", () => {
    expect(shapeOf(MACHINE_API_COPY.ja)).toEqual(shapeOf(MACHINE_API_COPY.en));
  });

  it("should state in both languages that Try-It is disabled", () => {
    expect(MACHINE_API_COPY.en.tryItHeading.toLowerCase()).toContain("try-it");
    expect(MACHINE_API_COPY.en.tryItBody.toLowerCase()).toContain("real data");
    expect(MACHINE_API_COPY.ja.tryItHeading).toContain("Try-It");
    expect(MACHINE_API_COPY.ja.tryItBody).toContain("実データ");
  });

  it("should have non-empty copy for every field in both locales", () => {
    for (const locale of ["ja", "en"] as const) {
      const walk = (value: unknown): void => {
        if (typeof value === "string") {
          expect(value.trim().length).toBeGreaterThan(0);
          return;
        }
        if (value && typeof value === "object") {
          for (const nested of Object.values(value)) walk(nested);
        }
      };
      walk(MACHINE_API_COPY[locale]);
    }
  });
});

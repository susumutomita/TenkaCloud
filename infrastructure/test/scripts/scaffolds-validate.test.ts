import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

/**
 * Issue #951 sub #1: `.claude/templates/problems/<kind>/metadata.json` の 5 種 scaffold が
 * `__PROBLEM_ID__` / `__PROBLEM_NAME__` を CLI が置換した後、 `problems/SCHEMA.json` に
 * 通ることを保証する。
 *
 * `scripts/tenkacloud-problem.ts create` が安全に動く前提を守る。 scaffold は新規問題作者の
 * 最初の入口なので、 invalid scaffold = onboarding 0 秒で詰む状態。 ここで pin する。
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const TEMPLATES_ROOT = join(REPO_ROOT, ".claude/templates/problems");
const SCHEMA_PATH = join(REPO_ROOT, "problems/SCHEMA.json");

function applyPlaceholders(content: string, problemId: string): string {
  const titleCase = problemId
    .split("-")
    .map((s) => (s.length > 0 ? s[0]?.toUpperCase() + s.slice(1) : ""))
    .join(" ");
  return content.replaceAll("__PROBLEM_ID__", problemId).replaceAll("__PROBLEM_NAME__", titleCase);
}

function listKinds(): readonly string[] {
  return readdirSync(TEMPLATES_ROOT)
    .filter((entry) => {
      const full = join(TEMPLATES_ROOT, entry);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

describe("Problem scaffold templates", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const kinds = listKinds();

  it("5 種の builtin kind の scaffold ディレクトリがすべて存在するべき", () => {
    const expected = ["attack-detection", "flag", "phased-polling", "uptime-flat", "uptime-multi"];
    expect(kinds).toEqual(expected);
  });

  for (const kind of kinds) {
    it(`${kind}/metadata.json は CLI 置換後 SCHEMA.json に通るべき`, () => {
      const raw = readFileSync(join(TEMPLATES_ROOT, kind, "metadata.json"), "utf8");
      const substituted = applyPlaceholders(raw, "scaffold-smoke-test");
      const json = JSON.parse(substituted);
      const ok = validate(json);
      if (!ok) {
        const errors = (validate.errors ?? [])
          .map((e) => `  ${e.instancePath} ${e.message}`)
          .join("\n");
        throw new Error(`scaffold ${kind} failed SCHEMA validation:\n${errors}`);
      }
      expect(ok).toBe(true);
    });

    it(`${kind}/template.yaml が存在するべき`, () => {
      const path = join(TEMPLATES_ROOT, kind, "template.yaml");
      expect(() => readFileSync(path, "utf8")).not.toThrow();
    });
  }
});

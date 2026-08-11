import { describe, expect, it } from "vitest";
import {
  buildDisruptionDispatch,
  buildRevertDispatch,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/dispatch-command";
import type { DisruptionAction } from "../../lib/utils/discover-problems-catalog";

/**
 * [#1419] executor の純粋 dispatch core を pin する。
 * - targetRef / functionRef を stackOutputs から解決 (未解決は throw)
 * - paramTemplate の {{key}} を fired parameters で置換 (値無しは throw)
 * - revert は同 kind/target + revert.paramTemplate/documentName で上書き
 */

const ssmAction: DisruptionAction = {
  kind: "ssm-run-command",
  targetRef: "WorkerInstanceIds",
  documentName: "AWS-RunShellScript",
  paramTemplate: { commands: ["tc qdisc add dev {{device}} root netem delay {{delayMs}}ms"] },
  revert: {
    afterSeconds: 600,
    documentName: "AWS-RunShellScript",
    paramTemplate: { commands: ["tc qdisc del dev {{device}} root"] },
  },
};

const stackOutputs = { WorkerInstanceIds: "i-aaa,i-bbb", FaultFn: "tc-fault-fn" };
const parameters = { device: "eth0", delayMs: 200 };

describe("buildDisruptionDispatch (#1419)", () => {
  it("should resolve targetRef from stackOutputs and substitute placeholders from fired parameters", () => {
    expect(buildDisruptionDispatch(ssmAction, parameters, stackOutputs)).toEqual({
      kind: "ssm-run-command",
      target: "i-aaa,i-bbb",
      documentName: "AWS-RunShellScript",
      params: { commands: ["tc qdisc add dev eth0 root netem delay 200ms"] },
    });
  });

  it("should resolve a lambda-invoke functionRef (preferred over targetRef) from stackOutputs", () => {
    const action: DisruptionAction = {
      kind: "lambda-invoke",
      targetRef: "WorkerInstanceIds",
      functionRef: "FaultFn",
      paramTemplate: { mode: "fail", device: "{{device}}" },
      revert: { afterSeconds: 30 },
    };
    expect(buildDisruptionDispatch(action, parameters, stackOutputs)).toEqual({
      kind: "lambda-invoke",
      target: "tc-fault-fn",
      params: { mode: "fail", device: "eth0" },
    });
  });

  it("should fall back to targetRef for lambda-invoke when functionRef is absent", () => {
    const action: DisruptionAction = {
      kind: "lambda-invoke",
      targetRef: "FaultFn",
      revert: { afterSeconds: 30 },
    };
    expect(buildDisruptionDispatch(action, parameters, stackOutputs).target).toBe("tc-fault-fn");
  });

  it("should return empty params when no paramTemplate is declared", () => {
    const action: DisruptionAction = {
      kind: "cfn-stack-update",
      targetRef: "WorkerInstanceIds",
      revert: { afterSeconds: 30 },
    };
    const dispatch = buildDisruptionDispatch(action, parameters, stackOutputs);
    expect(dispatch.params).toEqual({});
    expect(dispatch.documentName).toBeUndefined();
  });

  it("should throw when targetRef cannot be resolved from stackOutputs", () => {
    expect(() => buildDisruptionDispatch(ssmAction, parameters, { Other: "x" })).toThrow(
      /targetRef="WorkerInstanceIds" not found/,
    );
  });

  it("should throw when a placeholder has no value in the fired parameters", () => {
    expect(() => buildDisruptionDispatch(ssmAction, { device: "eth0" }, stackOutputs)).toThrow(
      /\{\{delayMs\}\} has no value/,
    );
  });

  it("should substitute placeholders nested inside arrays and objects", () => {
    const action: DisruptionAction = {
      kind: "ssm-run-command",
      targetRef: "WorkerInstanceIds",
      paramTemplate: { nested: { list: ["{{device}}", { deep: "delay-{{delayMs}}" }] } },
      revert: { afterSeconds: 1 },
    };
    expect(buildDisruptionDispatch(action, parameters, stackOutputs).params).toEqual({
      nested: { list: ["eth0", { deep: "delay-200" }] },
    });
  });

  it("should pass non-string leaves (number / boolean / null) through unchanged", () => {
    const action: DisruptionAction = {
      kind: "lambda-invoke",
      targetRef: "FaultFn",
      paramTemplate: { count: 3, enabled: true, note: null, label: "{{device}}" },
      revert: { afterSeconds: 1 },
    };
    expect(buildDisruptionDispatch(action, parameters, stackOutputs).params).toEqual({
      count: 3,
      enabled: true,
      note: null,
      label: "eth0",
    });
  });
});

describe("buildRevertDispatch (#1419 automatic revert dispatch)", () => {
  it("should reuse the inject target/kind and apply the revert paramTemplate + documentName", () => {
    expect(buildRevertDispatch(ssmAction, parameters, stackOutputs)).toEqual({
      kind: "ssm-run-command",
      target: "i-aaa,i-bbb",
      documentName: "AWS-RunShellScript",
      params: { commands: ["tc qdisc del dev eth0 root"] },
    });
  });

  it("should inherit the inject documentName when the revert omits it, and yield empty params with no revert template", () => {
    const action: DisruptionAction = {
      kind: "ssm-run-command",
      targetRef: "WorkerInstanceIds",
      documentName: "AWS-RunShellScript",
      revert: { afterSeconds: 60 },
    };
    expect(buildRevertDispatch(action, parameters, stackOutputs)).toEqual({
      kind: "ssm-run-command",
      target: "i-aaa,i-bbb",
      documentName: "AWS-RunShellScript",
      params: {},
    });
  });

  it("should yield no documentName when neither inject nor revert declares one", () => {
    const action: DisruptionAction = {
      kind: "lambda-invoke",
      targetRef: "FaultFn",
      revert: { afterSeconds: 60, paramTemplate: { mode: "recover" } },
    };
    const revert = buildRevertDispatch(action, parameters, stackOutputs);
    expect(revert.documentName).toBeUndefined();
    expect(revert.params).toEqual({ mode: "recover" });
  });
});

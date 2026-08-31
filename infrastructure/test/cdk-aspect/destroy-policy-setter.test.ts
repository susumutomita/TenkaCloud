import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { describe, expect, it } from "vitest";
import { DestroyPolicySetter } from "../../lib/cdk-aspect/destroy-policy-setter";
import { dataTableRemovalPolicy } from "../../lib/problem-deploy/data-table-removal-policy";

/**
 * Issue #2960: `DestroyPolicySetter` は CDK 既定が RETAIN の resource (LogGroup / UserPool /
 * Bucket) を Delete に倒し、destroy 後の孤児と課金を防ぐ。
 *
 * その一方で #2959 は `CDK_PARAM_RETAIN_DATA_TABLES=true` という **明示的に「残す」と言う経路**
 * を作った。Aspect は construct tree を後勝ちで舐めるので、素直に書くとこの opt-in を握り潰す。
 * 「残す」と言われた resource を黙って消すのは、この Aspect が防ぎたい事故と対称の事故になる。
 *
 * この file はその両立を証明する。片方だけ通る実装 (= Aspect を当てない / opt-in を無視する) は
 * どちらもここで落ちる。
 */

function templateWithAspect(
  build: (stack: Stack) => void,
  skipResourceTypes: readonly string[] = [],
): Template {
  const stack = new Stack(new App({ autoSynth: false }), "TestStack");
  build(stack);
  Aspects.of(stack).add(new DestroyPolicySetter({ skipResourceTypes }));
  return Template.fromStack(stack);
}

function policies(template: Template, type: string): { deletion?: string; updateReplace?: string } {
  const row = Object.values(template.findResources(type))[0] as
    | { DeletionPolicy?: string; UpdateReplacePolicy?: string }
    | undefined;
  if (!row) throw new Error(`${type} not found`);
  return { deletion: row.DeletionPolicy, updateReplace: row.UpdateReplacePolicy };
}

describe("#2960: DestroyPolicySetter closes the default-RETAIN leak", () => {
  it("should keep sweeping other types even while a type is excluded", () => {
    // 除外は type 単位。table を守る設定でも log group は Delete のままでなければ、
    // #2960 が塞ごうとしている log group の孤児がそのまま残る。
    const template = templateWithAspect(
      (stack) => {
        new LogGroup(stack, "Logs");
        new Table(stack, "Table", {
          partitionKey: { name: "PK", type: AttributeType.STRING },
          removalPolicy: dataTableRemovalPolicy(true),
        });
      },
      ["AWS::DynamoDB::Table"],
    );
    expect(policies(template, "AWS::Logs::LogGroup").deletion).toBe("Delete");
    expect(policies(template, "AWS::DynamoDB::Table").deletion).toBe("Retain");
  });

  it("should turn a CDK-default log group into Delete", () => {
    // LogGroup の CDK 既定は RETAIN。destroy 後に残って保存料金を出し続けていた実物がこれ。
    const template = templateWithAspect((stack) => {
      new LogGroup(stack, "Logs");
    });
    expect(policies(template, "AWS::Logs::LogGroup")).toEqual({
      deletion: "Delete",
      updateReplace: "Delete",
    });
  });

  it("should turn a table left at the CDK default into Delete", () => {
    const template = templateWithAspect((stack) => {
      new Table(stack, "Table", { partitionKey: { name: "PK", type: AttributeType.STRING } });
    });
    expect(policies(template, "AWS::DynamoDB::Table")).toEqual({
      deletion: "Delete",
      updateReplace: "Delete",
    });
  });
});

describe("#2960 x #2959: an explicit Retain survives the Aspect", () => {
  it("should not overwrite a table that opted in to RETAIN", () => {
    // これが両立の核心。ここが Delete になる実装は、利用者が明示的に残すと言ったデータを
    // 黙って消す。Aspect を当てる側の都合で opt-in を壊してはならない。
    const template = templateWithAspect(
      (stack) => {
        new Table(stack, "Table", {
          partitionKey: { name: "PK", type: AttributeType.STRING },
          removalPolicy: dataTableRemovalPolicy(true),
        });
      },
      ["AWS::DynamoDB::Table"],
    );
    expect(policies(template, "AWS::DynamoDB::Table")).toEqual({
      deletion: "Retain",
      updateReplace: "Retain",
    });
  });

  it("should still delete a table that opted out, so the default is not weakened", () => {
    // 逆向きの確認。除外リストが空なら (= opt-in していなければ) 通常どおり Delete に倒れる。
    const template = templateWithAspect((stack) => {
      new Table(stack, "Table", {
        partitionKey: { name: "PK", type: AttributeType.STRING },
        removalPolicy: dataTableRemovalPolicy(false),
      });
    });
    expect(policies(template, "AWS::DynamoDB::Table")).toEqual({
      deletion: "Delete",
      updateReplace: "Delete",
    });
  });
});

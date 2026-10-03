import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AdminAuditLogTable } from "../../lib/problem-deploy/admin-audit-log-table";
import { CompetitorAccountsTable } from "../../lib/problem-deploy/competitor-accounts-table";
import {
  type DataTableProps,
  dataTableRemovalPolicy,
} from "../../lib/problem-deploy/data-table-removal-policy";
import { DeploymentsTable } from "../../lib/problem-deploy/deployments-table";
import { DisruptionsTable } from "../../lib/problem-deploy/disruptions-table";
import { EventsTable } from "../../lib/problem-deploy/events-table";
import { ProblemEndpointsTable } from "../../lib/problem-deploy/problem-endpoints-table";
import { SamlIdpsTable } from "../../lib/problem-deploy/saml-idps-table";
import { TeamsTable } from "../../lib/problem-deploy/teams-table";

/**
 * Issue #2959: control-data DynamoDB table の削除方針を既定 DESTROY に反転する。
 *
 * 8 table すべてが RETAIN 固定だったため、`make destroy-saas` の後に table + GSI が残り
 * PROVISIONED 1 RCU / 1 WCU で課金され続けていた (実測 8 table + GSI 7 本 = 約 $9.60/月 が
 * 3 か月弱)。守るのは「意図せず消えないこと」ではなく「意図せず課金が残らないこと」に変えた。
 *
 * ここで見るのは `DeletionPolicy` と `UpdateReplacePolicy` の **両方**である。片方だけだと
 * stack 更新時の置換経路で古い table が残る。
 */

const TABLES: ReadonlyArray<{
  readonly name: string;
  readonly build: (scope: Stack, props: DataTableProps) => unknown;
}> = [
  { name: "Events", build: (s, p) => new EventsTable(s, "Events", p) },
  { name: "Deployments", build: (s, p) => new DeploymentsTable(s, "Deployments", p) },
  { name: "Teams", build: (s, p) => new TeamsTable(s, "Teams", p) },
  { name: "Disruptions", build: (s, p) => new DisruptionsTable(s, "Disruptions", p) },
  { name: "AdminAuditLog", build: (s, p) => new AdminAuditLogTable(s, "AdminAuditLog", p) },
  {
    name: "CompetitorAccounts",
    build: (s, p) => new CompetitorAccountsTable(s, "CompetitorAccounts", p),
  },
  {
    name: "ProblemEndpoints",
    build: (s, p) => new ProblemEndpointsTable(s, "ProblemEndpoints", p),
  },
  { name: "SamlIdps", build: (s, p) => new SamlIdpsTable(s, "SamlIdps", p) },
];

function policiesFor(props: DataTableProps): string[][] {
  return TABLES.map(({ build }) => {
    const stack = new Stack(new App({ autoSynth: false }), "TestStack");
    build(stack, props);
    const resources = Template.fromStack(stack).findResources("AWS::DynamoDB::Table");
    const row = Object.values(resources)[0] as
      | { DeletionPolicy?: string; UpdateReplacePolicy?: string }
      | undefined;
    if (!row) throw new Error("table resource not found");
    return [row.DeletionPolicy ?? "(absent)", row.UpdateReplacePolicy ?? "(absent)"];
  });
}

describe("#2959: control-data tables are destroyed by default", () => {
  it("should mark every table Delete when nothing is configured", () => {
    for (const [index, policies] of policiesFor({}).entries()) {
      expect(policies, `${TABLES[index]?.name} default`).toEqual(["Delete", "Delete"]);
    }
  });

  it("should mark every table Retain when the opt-in is passed", () => {
    const props = { removalPolicy: dataTableRemovalPolicy(true) };
    for (const [index, policies] of policiesFor(props).entries()) {
      expect(policies, `${TABLES[index]?.name} opt-in`).toEqual(["Retain", "Retain"]);
    }
  });

  it("should treat only the exact string true as the opt-in", () => {
    // env は文字列なので、"false" / "1" / undefined が誤って RETAIN に倒れないことを見る。
    // ここが緩むと「消えるつもりが残る」= 元の課金問題に戻る。
    expect(dataTableRemovalPolicy(undefined)).toBe("destroy");
    expect(dataTableRemovalPolicy(false)).toBe("destroy");
    expect(dataTableRemovalPolicy(true)).toBe("retain");
  });
});

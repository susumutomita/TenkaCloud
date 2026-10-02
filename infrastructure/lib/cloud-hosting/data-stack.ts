import { Aspects, CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { DestroyPolicySetter } from "../cdk-aspect/destroy-policy-setter.js";
import type { CloudControlDataResources } from "../problem-deploy/control-data-backend-env.js";
import { dataTableRemovalPolicy } from "../problem-deploy/data-table-removal-policy.js";
import type { CloudControlDataConfiguration } from "./config.js";
import { CloudHosting } from "./hosting.js";
import { scopeInvalidationPermissions } from "./invalidation-permissions.js";
import { applyOwnershipTags } from "./ownership-tags.js";

export interface CloudDataStackProps extends StackProps {
  readonly participantAssets: string;
  readonly environment: string;
  /** Explicit opt-in only; the historical default removes owned data on destroy. */
  readonly retainDataTables?: boolean;
  readonly controlData?: CloudControlDataConfiguration;
}
/** Historical Events/Teams/Deployments shapes and opt-in table retention. */
export class CloudDataStack extends Stack {
  readonly controlData: CloudControlDataResources;
  readonly portal: CloudHosting;
  constructor(scope: Construct, id: string, props: CloudDataStackProps) {
    super(scope, id, props);
    applyOwnershipTags(this, props.environment);
    Aspects.of(this).add(
      new DestroyPolicySetter({
        skipResourceTypes: props.retainDataTables === true ? ["AWS::DynamoDB::Table"] : [],
      }),
    );
    const selected = props.controlData ?? { kind: "dynamodb" };
    if (selected.kind === "turso") {
      this.controlData = selected;
      new CfnOutput(this, "TursoDatabaseUrl", { value: selected.databaseUrl });
      new CfnOutput(this, "TursoAuthTokenParameterName", {
        value: selected.authTokenParameterName,
      });
    } else {
      const table = (name: string) =>
        new Table(this, name, {
          partitionKey: { name: "PK", type: AttributeType.STRING },
          sortKey: { name: "SK", type: AttributeType.STRING },
          billingMode: BillingMode.PAY_PER_REQUEST,
          removalPolicy: dataTableRemovalPolicy(props.retainDataTables),
          deletionProtection: false,
        });
      const events = table("Events");
      const teams = table("Teams");
      const deployments = table("Deployments");
      for (const indexed of [events, deployments])
        indexed.addGlobalSecondaryIndex({
          indexName: "GSI1",
          partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
          sortKey: { name: "GSI1SK", type: AttributeType.STRING },
        });
      this.controlData = { kind: "dynamodb", events, teams, deployments };
      new CfnOutput(this, "EventsTableName", { value: events.tableName });
      new CfnOutput(this, "TeamsTableName", { value: teams.tableName });
      new CfnOutput(this, "DeploymentsTableName", { value: deployments.tableName });
    }
    this.portal = new CloudHosting(this, "ParticipantPortal", props.participantAssets);
    scopeInvalidationPermissions(this, [this.portal.distribution.distributionArn]);
    new CfnOutput(this, "ParticipantPortalApiUrl", { value: this.portal.url });
    new CfnOutput(this, "CloudControlDataBackend", { value: this.controlData.kind });
  }
}

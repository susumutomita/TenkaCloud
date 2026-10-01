import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { applyDeploymentBoundary } from "./deployment-boundary.js";
import { CloudHosting } from "./hosting.js";
import { scopeInvalidationPermissions } from "./invalidation-permissions.js";

export interface CloudDataStackProps extends StackProps {
  readonly participantAssets: string;
  readonly environment: string;
}
/** Historical Events/Teams/Deployments shapes, retained by default, with no tenant or SQL backend. */
export class CloudDataStack extends Stack {
  readonly events: Table;
  readonly teams: Table;
  readonly deployments: Table;
  readonly portal: CloudHosting;
  constructor(scope: Construct, id: string, props: CloudDataStackProps) {
    super(scope, id, props);
    applyDeploymentBoundary(this, props.environment);
    const table = (name: string) =>
      new Table(this, name, {
        partitionKey: { name: "PK", type: AttributeType.STRING },
        sortKey: { name: "SK", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.RETAIN,
        // Event expiry gates access; it must not silently delete tournament history.
        deletionProtection: true,
      });
    this.events = table("Events");
    this.teams = table("Teams");
    this.deployments = table("Deployments");
    for (const indexed of [this.events, this.deployments])
      indexed.addGlobalSecondaryIndex({
        indexName: "GSI1",
        partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
        sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      });
    this.portal = new CloudHosting(this, "ParticipantPortal", props.participantAssets);
    scopeInvalidationPermissions(this, [this.portal.distribution.distributionArn]);
    new CfnOutput(this, "ParticipantPortalApiUrl", { value: this.portal.url });
    new CfnOutput(this, "EventsTableName", { value: this.events.tableName });
    new CfnOutput(this, "TeamsTableName", { value: this.teams.tableName });
    new CfnOutput(this, "DeploymentsTableName", { value: this.deployments.tableName });
  }
}

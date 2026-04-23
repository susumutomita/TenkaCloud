import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names";
import { ApiGateway } from "./api-gateway";
import { IdentityProvider } from "./identity-provider";

interface TenantTemplateStackProps extends StackProps {
  stageName: string;
  lambdaReserveConcurrency: number;
  lambdaCanaryDeploymentPreference: string;
  isPooledDeploy: boolean;
  ApiKeySSMParameterNames: ApiKeySSMParameterNames;
  tenantId: string;
  tenantMappingTable: Table;
  commitId: string;
  waveNumber?: string;
}

export class TenantTemplateStack extends Stack {
  constructor(scope: Construct, id: string, props: TenantTemplateStackProps) {
    super(scope, id, props);
    const waveNumber = props.waveNumber || "1";

    const identityProvider = new IdentityProvider(this, "IdentityProvider", {
      tenantId: props.tenantId,
    });

    const apiGateway = new ApiGateway(this, "ApiGateway", {
      tenantId: props.tenantId,
      isPooledDeploy: props.isPooledDeploy,
      idpDetails: identityProvider.identityDetails,
      apiKeyBasicTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.basic.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.basic.value),
      },
      apiKeyStandardTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.standard.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.standard.value),
      },
      apiKeyPremiumTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.premium.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.premium.value),
      },
      apiKeyPlatinumTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.platinum.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.platinum.value),
      },
    });

    new AwsCustomResource(this, "CreateTenantMapping", {
      installLatestAwsSdk: true,
      onCreate: {
        service: "DynamoDB",
        action: "putItem",
        physicalResourceId: PhysicalResourceId.of("CreateTenantMapping"),
        parameters: {
          TableName: props.tenantMappingTable.tableName,
          Item: {
            tenantId: { S: props.tenantId },
            stackName: { S: Stack.of(this).stackName },
            codeCommitId: { S: props.commitId },
            waveNumber: { S: waveNumber },
          },
        },
      },
      onUpdate: {
        service: "DynamoDB",
        action: "updateItem",
        physicalResourceId: PhysicalResourceId.of("CreateTenantMapping"),
        parameters: {
          TableName: props.tenantMappingTable.tableName,
          Key: {
            tenantId: { S: props.tenantId },
          },
          UpdateExpression: "set codeCommitId = :codeCommitId",
          ExpressionAttributeValues: {
            ":codeCommitId": { S: props.commitId },
          },
        },
      },
      onDelete: {
        service: "DynamoDB",
        action: "deleteItem",
        parameters: {
          TableName: props.tenantMappingTable.tableName,
          Key: {
            tenantId: { S: props.tenantId },
          },
        },
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [props.tenantMappingTable.tableArn],
      }),
    });

    new CfnOutput(this, "ApiGatewayUrl", {
      value: apiGateway.restApi.url,
    });

    new CfnOutput(this, "TenantUserpoolId", {
      value: identityProvider.tenantUserPool.userPoolId,
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: identityProvider.tenantUserPoolClient.userPoolClientId,
    });
  }

  ssmLookup(parameterName: string) {
    return StringParameter.valueForStringParameter(this, parameterName);
  }
}

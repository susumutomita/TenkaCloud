import type {
  CfnDeployClient,
  CfnStackMutationInput,
  DdbConditionalPutClient,
} from "@TenkaCloud/trust-bridge";
import {
  type Capability,
  type CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

/**
 * trust-bridge の注入 seam に実 AWS SDK client を被せる薄い adapter 群。
 * ここだけが SDK を知り、 検証/実行/監査のロジックは trust-bridge に閉じる。
 */

export function buildDdbConditionalPutClient(client: DynamoDBClient): DdbConditionalPutClient {
  const doc = DynamoDBDocumentClient.from(client);
  return {
    async putItem(input) {
      await doc.send(
        new PutCommand({
          TableName: input.TableName,
          Item: input.Item,
          ConditionExpression: input.ConditionExpression,
        }),
      );
    },
  };
}

export function buildCfnDeployClient(client: CloudFormationClient): CfnDeployClient {
  const mutation = (input: CfnStackMutationInput) => ({
    StackName: input.StackName,
    TemplateBody: input.TemplateBody,
    Capabilities: [...input.Capabilities] as Capability[],
    ...(input.RoleARN ? { RoleARN: input.RoleARN } : {}),
  });
  return {
    async createStack(input) {
      const out = await client.send(new CreateStackCommand(mutation(input)));
      return out.StackId ? { StackId: out.StackId } : {};
    },
    async updateStack(input) {
      const out = await client.send(new UpdateStackCommand(mutation(input)));
      return out.StackId ? { StackId: out.StackId } : {};
    },
    async deleteStack(input) {
      await client.send(
        new DeleteStackCommand({
          StackName: input.StackName,
          ...(input.RoleARN ? { RoleARN: input.RoleARN } : {}),
        }),
      );
    },
  };
}

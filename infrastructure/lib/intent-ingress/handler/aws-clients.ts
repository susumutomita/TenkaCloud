import type { DdbConditionalPutClient } from "@TenkaCloud/trust-bridge";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

/**
 * ADR-049 Phase 4 (Issue #2293): thin AWS-SDK seam for the intent-ingress plane.
 *
 * The intent-ingress stack is deployed independently, so it owns its own minimal
 * `DdbConditionalPutClient` adapter (the same pattern the customer-execution plane
 * uses) rather than reaching into a sibling handler. This is the only file in the
 * plane that knows the DynamoDB SDK; the nonce single-consumption logic stays in
 * trust-bridge's `DdbNonceStore`.
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

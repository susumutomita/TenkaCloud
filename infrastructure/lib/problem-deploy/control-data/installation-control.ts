import { createHash } from "node:crypto";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { assertCommercialRegion } from "../../cloud-hosting/regions.js";
import { cloudStackNames } from "../../cloud-hosting/stack-names.js";

export const installationControlKey = { PK: "INSTALLATION", SK: "CONTROL" } as const;

/** A missing marker is a fresh accepting installation. Every stored marker closes intake. */
export function installationIntakeGuard(
  table: string,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  return {
    ConditionCheck: {
      TableName: table,
      Key: installationControlKey,
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

export const installationScopeSchema = z
  .object({
    account: z.string().regex(/^\d{12}$/u),
    region: z.string(),
    environment: z.string(),
    applicationStackId: z.string(),
    backendStackId: z.string(),
  })
  .strict()
  .superRefine((scope, context) => {
    assertCommercialRegion(scope.region);
    const names = cloudStackNames(scope.environment);
    for (const [arn, name] of [
      [scope.applicationStackId, names.app],
      [scope.backendStackId, names.backend],
    ] as const) {
      const prefix = `arn:aws:cloudformation:${scope.region}:${scope.account}:stack/${name}/`;
      if (!arn.startsWith(prefix) || !/^[A-Za-z0-9-]+$/u.test(arn.slice(prefix.length)))
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid installation scope" });
    }
  });
export type InstallationScope = z.infer<typeof installationScopeSchema>;

export const installationControlSchema = z.object({
  scope: installationScopeSchema,
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["DRAINING", "DRAINED"]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InstallationControl = z.infer<typeof installationControlSchema>;

export function installationScopeDigest(value: InstallationScope): string {
  const scope = installationScopeSchema.parse(value);
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.account,
        scope.region,
        scope.environment,
        scope.applicationStackId,
        scope.backendStackId,
      ]),
    )
    .digest("hex");
}

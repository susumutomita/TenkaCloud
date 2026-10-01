import { randomBytes } from "node:crypto";
import { GetParameterCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { z } from "zod";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";

const externalId = z.string().regex(/^[A-Za-z0-9_=,.@:/-]{16,128}$/u);
interface Options {
  readonly ssm: Pick<SSMClient, "send">;
  readonly parameterArn: string;
  readonly generate?: () => string;
  readonly reserveInitialization: () => Promise<boolean>;
  readonly recordUse: () => Promise<void>;
}
function named(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** Historical ensureExternalId, now one exact installation ARN; no rotation, old-version fallback, or deletion. */
export function createInstallationExternalIdStore(options: Options) {
  const match =
    /^arn:aws:ssm:([a-z0-9-]+):\d{12}:parameter(\/tenkacloud\/cloud\/[a-z0-9-]{1,64}\/external-id)$/u.exec(
      options.parameterArn,
    );
  const region = match?.[1];
  const name = match?.[2];
  if (!region || !name)
    throw new Error("An exact installation ExternalId parameter ARN is required.");
  assertCommercialRegion(region);
  const current = async (): Promise<string | undefined> => {
    try {
      const result = await options.ssm.send(
        new GetParameterCommand({ Name: options.parameterArn, WithDecryption: true }),
      );
      const parameter = result.Parameter;
      if (
        parameter?.ARN !== options.parameterArn ||
        parameter.Type !== "SecureString" ||
        !Number.isSafeInteger(parameter.Version) ||
        Number(parameter.Version) < 1
      )
        throw new Error("The installation ExternalId must be the exact current SecureString.");
      return externalId.parse(parameter.Value);
    } catch (error) {
      if (named(error, "ParameterNotFound")) return undefined;
      throw error;
    }
  };
  return {
    async ensure(): Promise<string> {
      const prior = await current();
      if (prior !== undefined) {
        await options.recordUse();
        return prior;
      }
      if (!(await options.reserveInitialization()))
        throw new Error(
          "The installation ExternalId is missing from a previously used or uncertain store; restore it instead of generating a replacement.",
        );
      const value = externalId.parse(options.generate?.() ?? randomBytes(32).toString("hex"));
      try {
        await options.ssm.send(
          new PutParameterCommand({
            Name: name,
            Value: value,
            Type: "SecureString",
            Overwrite: false,
          }),
        );
      } catch (error) {
        // Another concurrent first registration may have won. Any other SDK failure remains a failure.
        if (!named(error, "ParameterAlreadyExists")) throw error;
      }
      const saved = await current();
      if (saved === undefined) throw new Error("The installation ExternalId was not persisted.");
      await options.recordUse();
      return saved;
    },
  };
}

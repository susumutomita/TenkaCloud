import { createHash } from "node:crypto";
import { z } from "zod";
import { COMMERCIAL_REGION } from "../../../cloud-hosting/regions.js";

export const MAX_DEPLOYMENT_INPUT_BYTES = 128 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const region = z.string().max(32).regex(COMMERCIAL_REGION);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,254}$/);
const parameter = z
  .object({
    key,
    value: z
      .string()
      .max(4096)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 4096),
  })
  .strict()
  .readonly();
const inputSchema = z
  .object({
    version: z.literal(1),
    eventId: identifier,
    teamId: identifier,
    problemId: identifier,
    jobId: identifier,
    attemptId: identifier,
    target: z
      .object({
        accountId: z.string().regex(/^\d{12}$/),
        region,
        roleArn: z
          .string()
          .max(2048)
          .regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/),
        // The full ARN also binds the control-plane account and region of the secret.
        externalIdParameterArn: z
          .string()
          .max(2048)
          .regex(/^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/[\w./-]+$/)
          .refine((value) => COMMERCIAL_REGION.test(value.split(":")[3] ?? "")),
      })
      .strict()
      .refine((value) => value.roleArn.split(":")[4] === value.accountId)
      .readonly(),
    templateBody: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 51_200),
    parameters: z.array(parameter).max(200),
    capabilities: z.array(z.enum(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"])).max(2),
    allowedOutputKeys: z.array(key).max(16),
  })
  .strict();

export interface CloudDeploymentInput {
  readonly version: 1;
  readonly eventId: string;
  readonly teamId: string;
  readonly problemId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly target: {
    readonly accountId: string;
    readonly region: string;
    readonly roleArn: string;
    readonly externalIdParameterArn: string;
  };
  readonly templateBody: string;
  readonly parameters: readonly { readonly key: string; readonly value: string }[];
  readonly capabilities: readonly ("CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM")[];
  readonly allowedOutputKeys: readonly string[];
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Accept only a server-authorized, persisted snapshot, never raw participant request data.
 * Parsing clones, validates and freezes it before the first await. AWS credentials and the
 * decrypted AssumeRole ExternalId never belong here. Challenge parameters may be private:
 * store the snapshot server-side and never log it or return it to participants. Only the
 * commercial AWS partition is supported in this first slice.
 */
export function parseDeploymentInput(value: unknown): CloudDeploymentInput {
  let candidate = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_DEPLOYMENT_INPUT_BYTES) {
      throw new Error("Deployment input exceeds the serialized size limit");
    }
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new Error("Deployment input must be valid JSON");
    }
  }
  const result = inputSchema.safeParse(candidate);
  if (!result.success) throw new Error("Invalid cloud deployment input");
  const parsed = result.data;
  if (
    !unique(parsed.parameters.map((entry) => entry.key)) ||
    !unique(parsed.capabilities) ||
    !unique(parsed.allowedOutputKeys)
  ) {
    throw new Error("Deployment input contains duplicate parameter, capability or output keys");
  }
  const snapshot: CloudDeploymentInput = Object.freeze({
    ...parsed,
    parameters: Object.freeze([...parsed.parameters].sort((a, b) => (a.key < b.key ? -1 : 1))),
    capabilities: Object.freeze([...parsed.capabilities].sort()),
    allowedOutputKeys: Object.freeze([...parsed.allowedOutputKeys].sort()),
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_DEPLOYMENT_INPUT_BYTES) {
    throw new Error("Deployment input exceeds the serialized size limit");
  }
  return snapshot;
}

export function serializeDeploymentInput(value: unknown): string {
  return JSON.stringify(parseDeploymentInput(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function deploymentIdentity(input: CloudDeploymentInput) {
  const fingerprint = digest(input);
  // A new attempt or changed artifact must not silently create another paid stack. Adoption
  // still requires every ownership tag, including job, attempt and the complete request hash.
  const stackKey = digest([input.eventId, input.teamId, input.problemId]).slice(0, 40);
  return Object.freeze({
    stackName: `tc-cloud-${stackKey}`,
    fingerprint,
    clientRequestToken: `tc-create-${fingerprint}`,
  });
}

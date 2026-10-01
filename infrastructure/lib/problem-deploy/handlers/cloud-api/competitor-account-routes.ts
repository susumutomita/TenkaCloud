import type { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { COMMERCIAL_REGION } from "../../../cloud-hosting/regions.js";
import type {
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
} from "../../control-data/domain/competitor-accounts.js";
import { ApiError, type OrganizerAuthConfig, requireOrganizer } from "./auth.js";
import { body } from "./schema.js";

const accountId = z.string().regex(/^\d{12}$/u);
const region = z.string().regex(COMMERCIAL_REGION);
const roleName = z.string().regex(/^[A-Za-z0-9_+=,.@-]{1,64}$/u);
const entry = z
  .object({
    awsAccountId: accountId,
    region: region.optional(),
    competitorRoleName: roleName.optional(),
    alias: z.string().min(1).max(120).optional(),
  })
  .strict();
const createRequest = entry.extend({ competitorRoleName: roleName });
const bulkRequest = z
  .object({
    defaults: z
      .object({ region: region.optional(), competitorRoleName: roleName.optional() })
      .strict()
      .optional(),
    accounts: z.array(entry).min(1).max(50),
  })
  .strict();

export interface CloudCompetitorAccountsApi {
  readonly accounts: CompetitorAccountsRepository;
  readonly assertAccepting?: () => Promise<void>;
  readonly tenkaCloudAccountId: string;
  readonly competitorRoleName: string;
  readonly defaultRegion: string;
  /** Reuses one installation SecureString without rotation; never called by GET/DELETE. */
  readonly ensureExternalId: () => Promise<string>;
  readonly verify: (record: CompetitorAccountRecord) => Promise<void>;
}
interface Options extends CloudCompetitorAccountsApi {
  readonly organizerAuth: OrganizerAuthConfig;
  readonly now: () => number;
}
function summary(record: CompetitorAccountRecord) {
  return {
    awsAccountId: record.awsAccountId,
    region: record.region,
    competitorRoleName: record.competitorRoleName,
    ...(record.alias === undefined ? {} : { alias: record.alias }),
    verified: record.verified,
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
function newRecord(
  input: z.infer<typeof createRequest>,
  actor: string,
  now: number,
  options: Options,
) {
  if (input.awsAccountId === options.tenkaCloudAccountId)
    throw new ApiError(400, "competitor_control_plane_account_forbidden");
  if (input.competitorRoleName !== options.competitorRoleName)
    throw new ApiError(400, "competitor_role_not_supported");
  const at = new Date(now).toISOString();
  return {
    ...input,
    region: input.region ?? options.defaultRegion,
    registrationId: ulid(),
    revision: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: actor,
    verified: false,
  };
}
async function externalId(options: Options) {
  return z
    .string()
    .regex(/^[A-Za-z0-9_=,.@:/-]{16,128}$/u)
    .parse(await options.ensureExternalId());
}
async function requiredAccount(options: Options, value: string) {
  const record = await options.accounts.getAccount(accountId.parse(value));
  if (!record) throw new ApiError(404, "competitor_account_not_found");
  return record;
}
interface BulkResult {
  readonly awsAccountId: string;
  readonly outcome: "created" | "duplicate" | "invalid" | "failed";
  readonly message?: string;
}
async function bulkRegister(
  options: Options,
  input: z.infer<typeof bulkRequest>,
  actor: string,
  now: number,
) {
  const results: BulkResult[] = [];
  const seen = new Set<string>();
  let secret: string | undefined;
  for (const account of input.accounts) {
    const name = account.competitorRoleName ?? input.defaults?.competitorRoleName;
    if (
      seen.has(account.awsAccountId) ||
      name !== options.competitorRoleName ||
      account.awsAccountId === options.tenkaCloudAccountId
    ) {
      results.push({
        awsAccountId: account.awsAccountId,
        outcome: "invalid",
        message: "Duplicate request row or unsupported competitor account/role.",
      });
      continue;
    }
    seen.add(account.awsAccountId);
    const record = newRecord(
      { ...account, region: account.region ?? input.defaults?.region, competitorRoleName: name },
      actor,
      now,
      options,
    );
    try {
      if (await options.accounts.getAccount(account.awsAccountId)) {
        results.push({ awsAccountId: account.awsAccountId, outcome: "duplicate" });
        continue;
      }
      secret ??= await externalId(options);
      const result = await options.accounts.createAccount(record);
      results.push({
        awsAccountId: account.awsAccountId,
        outcome: result === "created" ? "created" : "duplicate",
      });
    } catch {
      // The historical API supports partial success. Never return SDK errors or secret-bearing inputs.
      results.push({
        awsAccountId: account.awsAccountId,
        outcome: "failed",
        message: "Registration failed; retry this account.",
      });
    }
  }
  const count = (outcome: BulkResult["outcome"]) =>
    results.filter((result) => result.outcome === outcome).length;
  const created = count("created");
  return {
    results,
    created,
    duplicate: count("duplicate"),
    invalid: count("invalid"),
    failed: count("failed"),
    ...(created > 0 ? { externalId: secret } : {}),
    tenkaCloudAccountId: options.tenkaCloudAccountId,
  };
}

/** Restored five existing organizer-client contracts; authentication still uses the shared Cognito boundary. */
export function registerCloudCompetitorAccountRoutes(app: Hono, options: Options): void {
  accountId.parse(options.tenkaCloudAccountId);
  roleName.parse(options.competitorRoleName);
  region.parse(options.defaultRegion);
  const path = "/admin/competitor-accounts";
  app.get(path, async (context) => {
    requireOrganizer(
      context,
      ["Admin", "Operator", "Viewer"],
      options.organizerAuth,
      options.now(),
    );
    return context.json({ items: (await options.accounts.listAccounts()).map(summary) });
  });
  app.post(path, async (context) => {
    const now = options.now();
    const actor = requireOrganizer(context, ["Admin"], options.organizerAuth, now);
    const input = createRequest.parse(await body(context));
    await options.assertAccepting?.();
    const record = newRecord(input, actor.sub, now, options);
    if (await options.accounts.getAccount(record.awsAccountId))
      throw new ApiError(409, "competitor_account_exists");
    const secret = await externalId(options);
    if ((await options.accounts.createAccount(record)) !== "created")
      throw new ApiError(409, "competitor_account_exists");
    return context.json(
      { ...summary(record), externalId: secret, tenkaCloudAccountId: options.tenkaCloudAccountId },
      201,
    );
  });
  app.post(`${path}/bulk`, async (context) => {
    const now = options.now();
    const actor = requireOrganizer(context, ["Admin"], options.organizerAuth, now);
    await options.assertAccepting?.();
    return context.json(
      await bulkRegister(options, bulkRequest.parse(await body(context)), actor.sub, now),
    );
  });
  app.post(`${path}/:awsAccountId/verify`, async (context) => {
    const now = options.now();
    requireOrganizer(context, ["Admin"], options.organizerAuth, now);
    z.object({})
      .strict()
      .parse(await body(context));
    const record = await requiredAccount(options, context.req.param("awsAccountId"));
    if (record.awsAccountId === options.tenkaCloudAccountId)
      throw new ApiError(409, "competitor_control_plane_account_forbidden");
    if (record.competitorRoleName !== options.competitorRoleName)
      throw new ApiError(409, "competitor_role_not_supported");
    const at = new Date(now).toISOString();
    try {
      await options.verify(record);
    } catch {
      if (!(await options.accounts.setVerified(record, false, at)))
        throw new ApiError(409, "competitor_account_changed");
      throw new ApiError(503, "competitor_verification_failed");
    }
    const updated = await options.accounts.setVerified(record, true, at);
    if (!updated) throw new ApiError(409, "competitor_account_changed");
    return context.json(summary(updated));
  });
  app.delete(`${path}/:awsAccountId`, async (context) => {
    requireOrganizer(context, ["Admin"], options.organizerAuth, options.now());
    const record = await requiredAccount(options, context.req.param("awsAccountId"));
    const result = await options.accounts.deleteAccount(record);
    if (result !== "deleted")
      throw new ApiError(
        409,
        result === "in_use" ? "competitor_account_in_use" : "competitor_account_changed",
      );
    return context.body(null, 204);
  });
}

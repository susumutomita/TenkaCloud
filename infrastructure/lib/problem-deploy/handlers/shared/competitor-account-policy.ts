import { z } from "zod";
import type { EventRecord } from "../../control-data/domain/events.js";

export const HostingAccountSelfTestRequestSchema = z.object({
  awsAccountId: z.string().regex(/^\d{12}$/u),
  riskVersion: z.literal("hosting-account-self-test-v1"),
});

export const HostingAccountSelfTestAcknowledgmentSchema =
  HostingAccountSelfTestRequestSchema.extend({
    acknowledgedAt: z.string().datetime(),
    acknowledgedBy: z.string().min(1),
  });

/** Only trusted server producers may construct this snapshot from a persisted event. */
export const HostingAccountSelfTestDispatchSchema =
  HostingAccountSelfTestAcknowledgmentSchema.extend({
    eventId: z.string().min(1),
    tenantId: z.string().min(1),
    jobId: z.string().min(1),
  });

export class UnsupportedHostingAccountError extends Error {
  readonly code = "unsupported_hosting_account";
  constructor(readonly awsAccountId: string) {
    super(
      "Using the hosting AWS account requires explicit self-test risk acknowledgment before deployment. Problem and participant roles may access or change hosting configuration and data, even in another region. Use a separate competitor account for events with third-party participants.",
    );
    this.name = "UnsupportedHostingAccountError";
  }
}

export function isHostingAccountSelfTestAcknowledged(
  event: Pick<EventRecord, "hostingAccountSelfTest"> | undefined,
  awsAccountId: string,
): boolean {
  const parsed = HostingAccountSelfTestAcknowledgmentSchema.safeParse(
    event?.hostingAccountSelfTest,
  );
  return parsed.success && parsed.data.awsAccountId === awsAccountId;
}

export function assertEventCompetitorAccount(
  awsAccountId: string,
  event: Pick<EventRecord, "hostingAccountSelfTest"> | undefined,
  hostingAccount = process.env.CONTROL_PLANE_ACCOUNT,
): void {
  if (
    hostingAccount &&
    awsAccountId === hostingAccount &&
    !isHostingAccountSelfTestAcknowledged(event, awsAccountId)
  )
    throw new UnsupportedHostingAccountError(awsAccountId);
}

/** Standalone deployments have no event on which to record self-test consent. */
export function assertSeparateCompetitorAccount(awsAccountId: string): void {
  assertEventCompetitorAccount(awsAccountId, undefined);
}

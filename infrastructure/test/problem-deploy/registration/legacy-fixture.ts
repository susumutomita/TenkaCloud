import { createHash } from "node:crypto";
import type { EventRecord } from "../../../lib/problem-deploy/control-data/events-repository";

export const tenantId = "retired-registration-fixture";
export const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const teamId = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
export const teamLoginKey = "k".repeat(43);
export const invitation = "i".repeat(43);
export const receipt = "r".repeat(43);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Existing data can still say enabled after the feature is retired. */
export function legacyEvent(): EventRecord {
  const now = new Date().toISOString();
  return {
    eventId,
    tenantId,
    name: "Legacy registration event",
    status: "READY",
    problems: [{ problemId: "office-link-gate", defaultRegion: "ap-northeast-1" }],
    teamCount: 2,
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    registration: {
      version: 2,
      enabled: true,
      invitationHash: digest(invitation),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
      teamIds: [teamId, "01ARZ3NDEKTSV4RRFFQ69G5FA2"],
      claims: [
        {
          receiptHash: digest(receipt),
          teamLoginKeyHash: digest(teamLoginKey),
          teamId,
          claimedAt: now,
        },
      ],
    },
  };
}

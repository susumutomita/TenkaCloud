/** Build the physical DynamoDB partition key for one problem's endpoint overrides. */
export function buildEndpointPK(tenantId: string, teamId: string, problemId: string): string {
  return `TENANT#${tenantId}#TEAM#${teamId}#PROBLEM#${problemId}`;
}

/** Build the physical DynamoDB sort key for one metadata-validated slot name. */
export function buildEndpointSK(slot: string): string {
  return `SLOT#${slot}`;
}

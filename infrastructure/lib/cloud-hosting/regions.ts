/** Existing exercise IAM templates target arn:aws; other partitions are deliberately unsupported. */
export const COMMERCIAL_REGION =
  /^(?:us|eu|ap|ca|sa|af|me|il|mx)-(?:central|north|northeast|northwest|south|southeast|southwest|east|west)-\d+$/u;
export function assertCommercialRegion(region: string): void {
  if (!COMMERCIAL_REGION.test(region))
    throw new Error(
      "Cloud hosting currently supports standard commercial AWS regions only (not GovCloud, China, or isolated partitions).",
    );
}

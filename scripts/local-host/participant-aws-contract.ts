import type { CliCredentialsView } from "@tenkacloud/portal-contracts";
import { HostError } from "./model";

export type ParticipantAwsAccess =
  | { readonly kind: "console"; readonly loginUrl: string }
  | { readonly kind: "cli"; readonly credentials: CliCredentialsView };

export class ParticipantAssumeRoleError extends HostError {
  constructor(readonly stage: "competitor" | "participant_viewer") {
    super(
      500,
      "AWS access could not be issued. Ask the organizer to check the role trust.",
      "assume_role_failed",
    );
  }
}

import type { CliCredentialsView } from "@tenkacloud/portal-contracts";
import { HostError } from "./model";

export interface ParticipantSessionCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

export type SimulatorConsoleIssuer = (
  input: {
    readonly credentials: ParticipantSessionCredentials;
    readonly region: string;
    /** Exactly one of the two names the target. */
    readonly parameterName?: string;
    readonly instanceId?: string;
  },
  assertCurrent: () => void,
) => Promise<string>;

export type ParticipantAwsAccess =
  | { readonly kind: "console"; readonly loginUrl: string }
  | { readonly kind: "cli"; readonly credentials: CliCredentialsView }
  | {
      readonly kind: "terminal";
      /** One-use code the participant pastes into the Simulator terminal page. */
      readonly code: string;
      readonly terminalUrl: string;
      readonly expiresAt: string;
    };

export class ParticipantAssumeRoleError extends HostError {
  constructor(readonly stage: "competitor" | "participant_viewer") {
    super(
      500,
      "AWS access could not be issued. Ask the organizer to check the role trust.",
      "assume_role_failed",
    );
  }
}

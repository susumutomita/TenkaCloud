export {
  HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY,
  isHumanAuthorizerAudiencePinEnabled,
  isMachineTokenPathEnabled,
  isNonAwsRuntimeEnabled,
  MACHINE_TOKEN_PATH_FEATURE_KEY,
  NON_AWS_RUNTIME_FEATURE_KEY,
  resolveAppConfig,
} from "./resolve.js";
export type { AppConfig } from "./types.js";

// Compatibility export for existing handler and test imports. The implementation lives outside
// `handlers/` so outbound runtime clients do not depend on the HTTP routing layer.
export {
  isSsrfSafeUrl,
  SSRF_BLOCKED_HOSTS,
  unwrapIPv6MappedIPv4,
} from "../../runtime-clients/ssrf-guard.js";

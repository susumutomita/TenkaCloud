import {
  type CliCredentialsView,
  normalizeSimulatorEndpointUrl,
} from "@tenkacloud/portal-contracts";

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("CLI credential contains an unsupported null byte.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellValue(value: string): string {
  return /^[A-Za-z0-9_./+=:-]+$/u.test(value) ? value : shellQuote(value);
}

/** Keep proxy settings for other hosts, including clients with different case precedence. */
function simulatorProxyBypass(endpoint: string): string {
  const hostname = new URL(endpoint).hostname;
  // Python's proxy matcher expects brackets; other clients use the bare IPv6 address.
  const hosts = hostname === "[::1]" ? [hostname, "::1"] : [hostname];
  return [
    `export NO_PROXY="\${NO_PROXY-\${no_proxy-}}"`,
    `export no_proxy="\${no_proxy-\${NO_PROXY-}}"`,
    ...["NO_PROXY", "no_proxy"].flatMap((variable) =>
      hosts.flatMap((host) => [
        `case ",\${${variable}}," in`,
        // A preexisting wildcard must stay a wildcard, not become the literal list "*,host".
        `  ',*,'|*,${shellQuote(host)},*) ;;`,
        `  *) export ${variable}="\${${variable}:+\${${variable}},}${host}" ;;`,
        "esac",
      ]),
    ),
  ].join("\n");
}

/** A function, not a command execution: older CLIs must receive an explicit endpoint too. */
function simulatorAwsFunction(endpoint: string, proxyBypass: string): string {
  return [
    "# Simulator-only AWS CLI wrapper. Use a fresh shell to return to real AWS.",
    "aws() (",
    `  if [ "\${AWS_ENDPOINT_URL-}" != ${endpoint} ]; then`,
    "    printf '%s\\n' 'Simulator endpoint is missing or changed; issue credentials again.' >&2",
    "    return 64",
    "  fi",
    "  for tenkacloud_arg do",
    '    case "$tenkacloud_arg" in',
    "      --?*)",
    // Reject full endpoint options and parser-supported abbreviations, with or without '='.
    `        case --endpoint-url in "\${tenkacloud_arg%%=*}"*)`,
    "          printf '%s\\n' 'Endpoint overrides are disabled in simulator mode.' >&2",
    "          return 64 ;;",
    "        esac ;;",
    "    esac",
    "  done",
    // Reestablish the local bypass if proxy exclusions changed after setup was sourced.
    ...proxyBypass.split("\n").map((line) => `  ${line}`),
    '  command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"',
    ")",
  ].join("\n");
}

export function buildShellExport(credentials: CliCredentialsView): string {
  if (credentials.simulator && credentials.endpointUrl === undefined)
    throw new Error("Simulator credentials require an explicit local endpoint.");
  const lines = [
    `export AWS_ACCESS_KEY_ID=${shellValue(credentials.accessKeyId)}`,
    `export AWS_SECRET_ACCESS_KEY=${shellValue(credentials.secretAccessKey)}`,
    `export AWS_SESSION_TOKEN=${shellValue(credentials.sessionToken)}`,
    `export AWS_REGION=${shellValue(credentials.region)}`,
  ];
  if (credentials.endpointUrl !== undefined) {
    const normalizedEndpoint = normalizeSimulatorEndpointUrl(credentials.endpointUrl);
    const endpoint = shellQuote(normalizedEndpoint);
    const proxyBypass = simulatorProxyBypass(normalizedEndpoint);
    lines.push(`export AWS_ENDPOINT_URL=${endpoint}`);
    lines.push(`export AWS_DEFAULT_REGION=${shellValue(credentials.region)}`);
    // Service-specific settings and this opt-out otherwise override the global endpoint.
    lines.push("export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=false");
    for (const service of ["STS", "SSM", "CLOUDFORMATION", "IAM"])
      lines.push(`export AWS_ENDPOINT_URL_${service}=${endpoint}`);
    // SDKs launched after sourcing need the same bypass as the CLI wrapper.
    lines.push("# Bypass ambient proxies only for the local Simulator endpoint.");
    lines.push(proxyBypass);
    lines.push(simulatorAwsFunction(endpoint, proxyBypass));
  }
  return lines.join("\n");
}

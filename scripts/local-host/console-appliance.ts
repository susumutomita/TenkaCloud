export interface ConsoleAppliance {
  readonly consoleOrigin: string;
  readonly webOriginTemplate: string;
  readonly webPort: number;
  readonly behindProxy: boolean;
  readonly webServiceIds: readonly string[];
}

export function consoleAppliance(values: Record<string, unknown>): ConsoleAppliance | undefined {
  const consoleOrigin = values["console-origin"];
  const template = values["web-origin-template"];
  if (consoleOrigin === undefined && template === undefined) return undefined;
  if (
    typeof consoleOrigin !== "string" ||
    typeof template !== "string" ||
    !values["competition-network"] ||
    !values["docker-network-pool"] ||
    values["unsafe-http"] ||
    values.lan ||
    values["vpn-peers"] ||
    values["public-admin-origin"] ||
    values["public-participant-origin"]
  )
    throw new Error(
      "Console appliance requires isolated native hosting, console and Web origins, without LAN/public/VPN peer modes.",
    );
  const consoleUrl = httpsOrigin(consoleOrigin);
  if (template.split("{target}").length !== 2 || !template.startsWith("https://{target}."))
    throw new Error("Web origin must start with https://{target}. and contain one target label.");
  const sample = httpsOrigin(template.replace("{target}", "a".repeat(32)));
  const suffix = sample.hostname.slice(32);
  if (consoleUrl.hostname.endsWith(suffix) || sample.origin === consoleUrl.origin)
    throw new Error("The console must be outside the challenge origin namespace.");
  const webPort = Number(values["web-port"] ?? 5176);
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
    throw new Error("Invalid Web broker port.");
  const selected = values["web-services"] ?? "web";
  if (typeof selected !== "string") throw new Error("Web services must be declared IDs.");
  const ids = selected.split(",");
  if (
    !ids.length ||
    ids.length > 8 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id))
  )
    throw new Error("Select up to eight declared Web service IDs.");
  return {
    behindProxy: values["behind-proxy"] === true,
    consoleOrigin: consoleUrl.origin,
    webOriginTemplate: template,
    webPort,
    webServiceIds: ids,
  };
}

function httpsOrigin(raw: string): URL {
  const value = new URL(raw);
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.pathname !== "/" ||
    value.search ||
    value.hash ||
    value.hostname.includes("*") ||
    value.origin !== raw.replace(/\/$/u, "")
  )
    throw new Error("An exact HTTPS origin without credentials, path or wildcard is required.");
  return value;
}

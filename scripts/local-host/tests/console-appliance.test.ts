import { expect, test } from "bun:test";
import { consoleAppliance } from "../console-appliance";
import { parseOptions } from "../options";

const isolated = {
  "console-origin": "https://play.example.test",
  "web-origin-template": "https://{target}.labs.example.test",
  "competition-network": true,
  "docker-network-pool": "synthetic-unused-pool",
  "behind-proxy": true,
};

test("console-only hosting requires exact HTTPS origins outside the challenge namespace", () => {
  expect(consoleAppliance({})).toBeUndefined();
  expect(consoleAppliance(isolated)).toEqual({
    consoleOrigin: isolated["console-origin"],
    webOriginTemplate: isolated["web-origin-template"],
    behindProxy: true,
    webPort: 5176,
    webServiceIds: ["web"],
  });
  for (const patch of [
    { "console-origin": "http://play.example.test" },
    { "console-origin": "https://play.labs.example.test" },
    { "console-origin": "https://user:secret@play.example.test" },
    { "web-origin-template": "https://{target}.labs.example.test/path" },
    { "web-origin-template": "https://labs.example.test/{target}" },
    { "web-origin-template": "https://{target}.{target}.example.test" },
    { "competition-network": false },
    { "docker-network-pool": undefined },
    { "unsafe-http": true },
    { lan: true },
    { "vpn-peers": "peers.json" },
    { "public-admin-origin": "https://admin.example.test" },
    { "public-participant-origin": "https://portal.example.test" },
    { "web-port": "5176.5" },
    { "web-services": "web,web" },
    { "web-services": "http://example.test" },
  ])
    expect(() => consoleAppliance({ ...isolated, ...patch })).toThrow();
});

test("CLI wires isolated console-only hosting to loopback and reserves the Web broker port", () => {
  const args = [
    "--competition-network",
    "--docker-network-pool",
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic CLI configuration; no connection
    "10.240.0.0/16",
    "--console-origin",
    isolated["console-origin"],
    "--web-origin-template",
    isolated["web-origin-template"],
    "--behind-proxy",
  ];
  const options = parseOptions(args, "/tmp", {});
  expect(options.hostname).toBe("127.0.0.1");
  expect(options.adminPort).toBe(5174);
  expect(options.participantPort).toBe(5175);
  expect(options.public).toBeUndefined();
  expect(options.consoleAppliance?.consoleOrigin).toBe(isolated["console-origin"]);
  for (const port of ["5174", "5175", "5200"])
    expect(() => parseOptions([...args, "--web-port", port], "/tmp", {})).toThrow();
});

import { expect, test } from "bun:test";
import { parseOptions, vpnListener } from "../options";

const vpnArgs = [
  "--competition-network",
  "--docker-network-pool",
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic CLI configuration; no connection
  "10.240.0.0/16",
  "--vpn-peers",
  "/etc/tenkacloud/vpn/event.json",
];

test("the VPN registration's participant port reaches the listener without a CLI flag", () => {
  const options = parseOptions(vpnArgs, "/tmp");
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic VPN server identity
  expect(vpnListener(options, { serverIpv4: "10.251.0.1", participantPort: 5300 })).toEqual({
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic VPN server identity
    hostname: "10.251.0.1",
    participantPort: 5300,
  });
});

test("a VPN participant port that collides with the console or gateway ports is refused", () => {
  const options = parseOptions(vpnArgs, "/tmp");
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic VPN server identity
  const plan = (participantPort: number) => ({ serverIpv4: "10.251.0.1", participantPort });
  expect(() => vpnListener(options, plan(options.adminPort))).toThrow("different ports");
  expect(() => vpnListener(options, plan(options.gatewayPorts.start))).toThrow("--gateway-ports");
});

test("an explicit participant port cannot silently disagree with the VPN registration", () => {
  expect(() => parseOptions([...vpnArgs, "--participant-port", "5175"], "/tmp")).toThrow(
    "omit --participant-port",
  );
  expect(parseOptions(["--participant-port", "5300"], "/tmp").participantPort).toBe(5300);
  expect(parseOptions([], "/tmp").participantPort).toBe(5175);
});

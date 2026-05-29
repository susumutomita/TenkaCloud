import { describe, expect, it } from "vitest";
import {
  isSsrfSafeUrl,
  SSRF_BLOCKED_HOSTS,
  unwrapIPv6MappedIPv4,
} from "../../lib/problem-deploy/handlers/shared/ssrf-guard";

/**
 * SSRF defense-in-depth guard (shared by endpoint override write-validation and the scoring
 * engine probe). Extracted from problem-endpoints-handler; behavior must stay equivalent and
 * additionally block the ECS/EKS container-credential endpoints (#1392).
 */

describe("unwrapIPv6MappedIPv4", () => {
  it("should unwrap dotted IPv6-mapped IPv4 to the bare IPv4", () => {
    expect(unwrapIPv6MappedIPv4("::ffff:169.254.169.254")).toBe("169.254.169.254");
    expect(unwrapIPv6MappedIPv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  it("should unwrap hex IPv6-mapped IPv4 to the bare IPv4", () => {
    expect(unwrapIPv6MappedIPv4("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
  });

  it("should return native IPv4 / non-mapped IPv6 unchanged", () => {
    expect(unwrapIPv6MappedIPv4("127.0.0.1")).toBe("127.0.0.1");
    expect(unwrapIPv6MappedIPv4("fd00:ec2::254")).toBe("fd00:ec2::254");
    expect(unwrapIPv6MappedIPv4("my-host.example.com")).toBe("my-host.example.com");
  });
});

describe("isSsrfSafeUrl", () => {
  it("should accept ordinary public https/http hosts (incl. private RFC1918 by design)", () => {
    expect(isSsrfSafeUrl("https://my-host.example.com/health")).toBe(true);
    expect(isSsrfSafeUrl("http://my-host.example.com:8080/")).toBe(true);
    // 私設 IP は Battle 参加者の自 account endpoint 登録のため intentional に許可。
    expect(isSsrfSafeUrl("http://10.0.1.5/healthz")).toBe(true);
    expect(isSsrfSafeUrl("http://172.16.0.10/")).toBe(true);
  });

  it("should reject non-http(s) schemes", () => {
    expect(isSsrfSafeUrl("ftp://example.com/x")).toBe(false);
    expect(isSsrfSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSsrfSafeUrl("gopher://example.com")).toBe(false);
  });

  it("should reject malformed URLs", () => {
    expect(isSsrfSafeUrl("not a url")).toBe(false);
    expect(isSsrfSafeUrl("")).toBe(false);
  });

  it.each([
    ["AWS IMDS v4", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["AWS IMDS v6", "http://[fd00:ec2::254]/latest/meta-data/"],
    ["AWS IMDS v6 expanded", "http://[fd00:ec2:0:0:0:0:0:254]/latest/meta-data/"],
    ["ECS task-role credentials", "http://169.254.170.2/v2/credentials/"],
    ["EKS Pod Identity (IPv4)", "http://169.254.170.23/v1/credentials"],
    ["EKS Pod Identity (IPv6)", "http://[fd00:ec2::23]/v1/credentials"],
    ["GCE metadata", "http://metadata.google.internal/computeMetadata/v1/"],
    ["loopback IPv4", "http://127.0.0.1:9001/admin"],
    ["loopback all-zero IPv4", "http://0.0.0.0:9001/admin"],
    ["loopback IPv6", "http://[::1]/"],
    ["localhost literal", "http://localhost/"],
    ["IPv6-mapped IMDS (dotted)", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
    ["IPv6-mapped IMDS (hex)", "http://[::ffff:a9fe:a9fe]/latest/meta-data/"],
    ["IPv6-mapped loopback", "http://[::ffff:127.0.0.1]/admin"],
  ])("should reject the %s host", (_, url) => {
    expect(isSsrfSafeUrl(url)).toBe(false);
  });

  it("should include the container-credential endpoints in the blocklist", () => {
    expect(SSRF_BLOCKED_HOSTS.has("169.254.170.2")).toBe(true);
    expect(SSRF_BLOCKED_HOSTS.has("169.254.170.23")).toBe(true);
    expect(SSRF_BLOCKED_HOSTS.has("fd00:ec2::23")).toBe(true);
  });
});

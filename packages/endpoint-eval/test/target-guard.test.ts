import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_WORKERS_POLICY,
  guardTargetUrl,
  LOCAL_CONTAINER_POLICY,
  type TargetPolicy,
} from "../src/target-guard.js";

describe("guardTargetUrl — Cloudflare Workers policy", () => {
  it("should accept an https *.workers.dev subdomain", () => {
    const r = guardTargetUrl(
      "https://team-7.example.workers.dev/healthz",
      CLOUDFLARE_WORKERS_POLICY,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("team-7.example.workers.dev");
  });

  it("should reject a suffix-spoofed host (foo.workers.dev.evil.example)", () => {
    const r = guardTargetUrl("https://foo.workers.dev.evil.example/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("許可リスト");
  });

  it("should reject a lookalike host without the leading dot (xworkers.dev)", () => {
    const r = guardTargetUrl("https://xworkers.dev/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
  });

  it("should reject the bare apex (workers.dev) — a subdomain is required", () => {
    const r = guardTargetUrl("https://workers.dev/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
  });

  it("should reject http:", () => {
    const r = guardTargetUrl("http://a.workers.dev/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("http:");
  });

  it("should reject a non-http(s) protocol", () => {
    const r = guardTargetUrl("ftp://a.workers.dev/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("プロトコル");
  });

  it("should reject userinfo in the URL", () => {
    const r = guardTargetUrl("https://user:pass@a.workers.dev/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ユーザー情報");
  });

  it("should reject a non-standard port under the workers policy", () => {
    const r = guardTargetUrl("https://a.workers.dev:8443/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ポート");
  });

  it("should accept the explicit standard 443 port", () => {
    const r = guardTargetUrl("https://a.workers.dev:443/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(true);
  });

  it("should reject a raw public IPv4 literal", () => {
    const r = guardTargetUrl("https://93.184.216.34/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("IP アドレス");
  });

  it("should reject a public IPv6 literal", () => {
    const r = guardTargetUrl(
      "https://[2606:2800:220:1:248:1893:25c8:1946]/",
      CLOUDFLARE_WORKERS_POLICY,
    );
    expect(r.ok).toBe(false);
  });

  it("should reject localhost / loopback / private under the workers policy", () => {
    expect(guardTargetUrl("https://localhost/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://127.0.0.1/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://10.0.0.5/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://192.168.1.1/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://172.16.0.1/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://169.254.1.1/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://[::1]/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://[fc00::1]/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://[fe80::1]/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
    expect(guardTargetUrl("https://0.0.0.0/", CLOUDFLARE_WORKERS_POLICY).ok).toBe(false);
  });

  it("should reject a malformed URL", () => {
    const r = guardTargetUrl("not a url", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("形式");
  });

  it("should reject an out-of-range IPv4 literal (rejected by URL parsing)", () => {
    const r = guardTargetUrl("https://999.1.1.1/", CLOUDFLARE_WORKERS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("形式");
  });
});

describe("guardTargetUrl — local container policy", () => {
  it("should accept http://localhost with a non-standard port", () => {
    const r = guardTargetUrl("http://localhost:8787/healthz", LOCAL_CONTAINER_POLICY);
    expect(r.ok).toBe(true);
  });

  it("should accept a loopback IPv4 and a private IPv4", () => {
    expect(guardTargetUrl("http://127.0.0.1:3000/", LOCAL_CONTAINER_POLICY).ok).toBe(true);
    expect(guardTargetUrl("http://10.1.2.3:9000/", LOCAL_CONTAINER_POLICY).ok).toBe(true);
  });

  it("should still reject a raw public IP even in local mode", () => {
    expect(guardTargetUrl("http://93.184.216.34/", LOCAL_CONTAINER_POLICY).ok).toBe(false);
  });

  it("should accept an arbitrary hostname when no suffix allowlist is set", () => {
    expect(guardTargetUrl("https://my-container.internal/", LOCAL_CONTAINER_POLICY).ok).toBe(true);
  });
});

describe("guardTargetUrl — http allowed but non-standard ports forbidden", () => {
  const HTTP_STRICT_PORT: TargetPolicy = {
    allowedHostSuffixes: [],
    allowLoopback: true,
    allowPrivateIp: false,
    allowNonStandardPort: false,
    allowHttp: true,
  };

  it("should accept the http standard port (80) and reject a non-standard one", () => {
    expect(guardTargetUrl("http://localhost:80/", HTTP_STRICT_PORT).ok).toBe(true);
    expect(guardTargetUrl("http://localhost:8080/", HTTP_STRICT_PORT).ok).toBe(false);
  });
});

describe("guardTargetUrl — other-cloud policy", () => {
  const GCP_RUN_POLICY: TargetPolicy = {
    allowedHostSuffixes: [".run.app", ".azurewebsites.net"],
    allowLoopback: false,
    allowPrivateIp: false,
    allowNonStandardPort: false,
    allowHttp: false,
  };

  it("should accept a Cloud Run host via the multi-suffix allowlist", () => {
    expect(guardTargetUrl("https://svc-abc.a.run.app/", GCP_RUN_POLICY).ok).toBe(true);
    expect(guardTargetUrl("https://app.azurewebsites.net/", GCP_RUN_POLICY).ok).toBe(true);
  });

  it("should reject a workers.dev host under a non-workers policy", () => {
    expect(guardTargetUrl("https://a.workers.dev/", GCP_RUN_POLICY).ok).toBe(false);
  });
});

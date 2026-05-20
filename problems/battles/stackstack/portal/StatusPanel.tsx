/**
 * StackStack portal slot — 5-axis subscore display.
 *
 * 5 slot (auth / network / rate / audit / ux) の effective URL と、 phase/disruption
 * の予告 countdown を 1 panel にまとめる。 portal の標準 StatusPanel ではなく本 plugin
 * が render される (= metadata.dashboard.slots.StatusPanel で指名)。
 *
 * Cloudscape は import しない (= plugin bundle が portal 本体と二重化しないよう、
 * plain HTML + inline style で書く / microservice-migration-battle と同じ方針)。
 */

import type { PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";

const AXIS_LABELS: Record<string, { label: string; hint: string }> = {
  auth: { label: "Auth", hint: "Cognito / SSO + scoped IAM への移行で hardened" },
  network: { label: "Network", hint: "CloudFront + OAC + scoped IAM への移行で hardened" },
  rate: { label: "Rate", hint: "API GW throttle / Lambda concurrency への移行で hardened" },
  audit: { label: "Audit", hint: "CloudTrail + S3 WORM + Athena への移行で hardened" },
  ux: { label: "UX", hint: "ALB + Multi-AZ + Auto Scaling への移行で hardened" },
};

export default function StatusPanel(props: PortalSlotProps) {
  const { endpoints, phases, disruptions } = props;
  const orderedEndpoints = ["auth", "network", "rate", "audit", "ux"]
    .map((slot) => endpoints.find((ep) => ep.slot === slot))
    .filter((ep): ep is (typeof endpoints)[number] => ep !== undefined);

  return (
    <section
      style={{
        border: "1px solid #d5dbdb",
        borderRadius: "8px",
        padding: "16px",
        background: "#fafafa",
      }}
    >
      <h3 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>
        StackStack — 5-axis hardening status
      </h3>
      <p style={{ margin: "0 0 16px 0", color: "#5f6b7a", fontSize: "13px" }}>
        各 slot を managed runtime (Lambda + API GW / ECS Fargate / App Runner) に切り出して
        override 登録すると platform 加点が 100 pt → 1000 pt にジャンプします。 全 5 slot が managed
        に乗ると <strong>+5000 pt one-time bonus</strong>。
      </p>

      <div style={{ marginBottom: "16px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #d5dbdb", textAlign: "left" }}>
              <th style={{ padding: "4px 8px" }}>Slot</th>
              <th style={{ padding: "4px 8px" }}>Effective URL</th>
              <th style={{ padding: "4px 8px" }}>Override?</th>
              <th style={{ padding: "4px 8px" }}>Hardening tip</th>
            </tr>
          </thead>
          <tbody>
            {orderedEndpoints.map((ep) => {
              const axis = AXIS_LABELS[ep.slot];
              return (
                <tr key={ep.slot} style={{ borderBottom: "1px solid #eaeded" }}>
                  <td style={{ padding: "4px 8px", fontWeight: 500 }}>
                    {axis?.label ?? ep.label ?? ep.slot}
                  </td>
                  <td style={{ padding: "4px 8px", fontFamily: "monospace", fontSize: "12px" }}>
                    {ep.effectiveUrl ?? "—"}
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    {ep.overrideUrl ? (
                      <span style={{ color: "#1a7f37", fontWeight: 600 }}>hardened</span>
                    ) : (
                      <span style={{ color: "#9a6700" }}>ec2 (naive)</span>
                    )}
                  </td>
                  <td style={{ padding: "4px 8px", color: "#5f6b7a" }}>{axis?.hint ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {phases.length > 0 && (
        <div style={{ marginBottom: "12px" }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: "13px", color: "#414d5c" }}>
            Upcoming phases
          </h4>
          <ul style={{ margin: "0", paddingLeft: "20px", fontSize: "13px" }}>
            {phases.map((p) => (
              <li key={p.name}>
                <strong>+{p.afterMinutes} 分</strong> — {p.name}
                {p.description && <span style={{ color: "#5f6b7a" }}>: {p.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {disruptions.length > 0 && (
        <div>
          <h4 style={{ margin: "0 0 8px 0", fontSize: "13px", color: "#d13212" }}>
            Random org events (operator-fired)
          </h4>
          <ul style={{ margin: "0", paddingLeft: "20px", fontSize: "13px" }}>
            {disruptions.map((d) => (
              <li key={d.id}>
                <strong>{d.name}</strong>
                {typeof d.defaultAfterMinutes === "number" && (
                  <span style={{ color: "#5f6b7a" }}> (default +{d.defaultAfterMinutes} 分)</span>
                )}
                {d.description && <span style={{ color: "#5f6b7a" }}>: {d.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

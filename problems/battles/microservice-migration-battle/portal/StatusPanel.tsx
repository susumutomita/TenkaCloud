/**
 * ADR-012 Phase 5: microservice-migration-battle 専用 StatusPanel plugin。
 *
 * 自チームの 3 slot (users / orders / catalog) の effective URL と、 phase / disruption
 * の予告 countdown を 1 panel にまとめて表示する。 portal の標準 StatusPanel ではなく
 * 本 plugin が render される (= metadata.dashboard.slots.StatusPanel で指名済)。
 *
 * 設計判断: Cloudscape は使わない (= Phase 5 MVP は plugin bundle が
 * peer-dep を持たない build-time integration、 Cloudscape import は portal 本体側で発生する
 * ため plugin 側で直接 import すると bundle 二重化する)。 plain HTML + inline style で書く。
 */

import type { PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";

export default function StatusPanel(props: PortalSlotProps) {
  const { endpoints, phases, disruptions } = props;
  return (
    <section
      style={{
        border: "1px solid #d5dbdb",
        borderRadius: "8px",
        padding: "16px",
        background: "#fafafa",
      }}
    >
      <h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>Microservice Migration — Status</h3>
      <p style={{ margin: "0 0 16px 0", color: "#5f6b7a" }}>
        users / orders / catalog の 3 endpoint の現在 routing 先と、 残り時間予告を表示します。
        endpoint を override 登録すると、 platform の scoring engine が新 URL を probe します。
      </p>

      <div style={{ marginBottom: "16px" }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: "13px", color: "#414d5c" }}>Endpoint slots</h4>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #d5dbdb", textAlign: "left" }}>
              <th style={{ padding: "4px 8px" }}>Slot</th>
              <th style={{ padding: "4px 8px" }}>Effective URL</th>
              <th style={{ padding: "4px 8px" }}>Override?</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((ep) => (
              <tr key={ep.slot} style={{ borderBottom: "1px solid #eaeded" }}>
                <td style={{ padding: "4px 8px", fontWeight: 500 }}>{ep.label ?? ep.slot}</td>
                <td style={{ padding: "4px 8px", fontFamily: "monospace", fontSize: "12px" }}>
                  {ep.effectiveUrl ?? "—"}
                </td>
                <td style={{ padding: "4px 8px" }}>
                  {ep.overrideUrl ? "yes (override)" : "no (default)"}
                </td>
              </tr>
            ))}
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
          <h4 style={{ margin: "0 0 8px 0", fontSize: "13px", color: "#d13212" }}>Disruptions</h4>
          <ul style={{ margin: "0", paddingLeft: "20px", fontSize: "13px" }}>
            {disruptions.map((d) => (
              <li key={d.id}>
                {typeof d.defaultAfterMinutes === "number" && (
                  <strong>+{d.defaultAfterMinutes} 分</strong>
                )}{" "}
                {d.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

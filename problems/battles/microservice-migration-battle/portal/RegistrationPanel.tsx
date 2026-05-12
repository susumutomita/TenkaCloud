/**
 * ADR-012 Phase 5: microservice-migration-battle 専用 RegistrationPanel plugin。
 *
 * 競技者が users / orders / catalog の 3 slot を順次 Lambda / ECS / App Runner に移行する際、
 * 切り出した service の URL を override として登録する form。 form は label 表示のみで、
 * 実際の override 反映は portal API (= POST /portal/me/problems/<id>/endpoints/<slot>) を
 * 叩く必要がある (= Phase 5 では link 案内のみ、 form 送信は Phase 6 で integrate)。
 *
 * 設計判断: 本 plugin は instructional purpose に絞る (= "ここで何をするか" を伝える)。
 * 実際の input form は portal の標準 EndpointOverrideForm 経由 (= Phase 3.A で実装済) を
 * 使う想定。 plugin 側で別 form を実装すると 2 重メンテになるので避ける。
 */

import type { PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";

export default function RegistrationPanel(props: PortalSlotProps) {
  const { endpoints } = props;
  return (
    <section
      style={{
        border: "1px solid #d5dbdb",
        borderRadius: "8px",
        padding: "16px",
        background: "#fff8e5",
      }}
    >
      <h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>
        Microservice Migration — Endpoint Registration
      </h3>
      <p style={{ margin: "0 0 12px 0", fontSize: "13px", color: "#414d5c" }}>
        各 slot を切り出したら override で登録すると、 scoring engine が新 endpoint に
        切り替わります。 登録は portal の標準 "Endpoint override" form から行います。
      </p>
      <ul style={{ margin: "0", paddingLeft: "20px", fontSize: "13px" }}>
        {endpoints.map((ep) => (
          <li key={ep.slot} style={{ marginBottom: "4px" }}>
            <strong>{ep.label ?? ep.slot}</strong>
            {ep.description && <span style={{ color: "#5f6b7a" }}>: {ep.description}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

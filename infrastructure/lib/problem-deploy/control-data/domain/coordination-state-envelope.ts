import type { CoordinationScoreDelivery } from "./coordination-score.js";

/**
 * [Issue #3150] platform が `state` に被せる封筒。
 * [Issue #3194] repository は plugin state を解釈せず、platform の pendingScores だけを
 * 配信の条件・acknowledgement に使う。既存 DDB item / SQL row に保存し、DDL は変えない。
 *
 * [Issue #3150] Codex review: マーカー 1 つでの判定は不十分。 plugin の State は `unknown` なので
 * どんな形もあり得る -- たまたま同じ key を持つ旧 state を封筒と誤認すると、 `state.state` が
 * undefined になって plugin に渡り、 500 か次の write での破壊になる。 **封筒の形が完全に
 * 揃ったときだけ**封筒と見なす (マーカー + 正の整数 version + `state` key の存在)。
 */
export interface CoordinationStateEnvelope {
  readonly __tenkacloudCoordinationEnvelope: 1;
  readonly stateSchemaVersion: number;
  readonly pendingScores?: CoordinationScoreDelivery;
  readonly state: unknown;
}

export const COORDINATION_ENVELOPE_MARKER = 1;

export function isCoordinationStateEnvelope(raw: unknown): raw is CoordinationStateEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.__tenkacloudCoordinationEnvelope !== COORDINATION_ENVELOPE_MARKER) return false;
  if (
    typeof r.stateSchemaVersion !== "number" ||
    !Number.isInteger(r.stateSchemaVersion) ||
    r.stateSchemaVersion <= 0
  ) {
    return false;
  }
  return Object.hasOwn(r, "state");
}

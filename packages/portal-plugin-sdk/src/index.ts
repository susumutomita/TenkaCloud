/**
 * @tenkacloud/portal-plugin-sdk
 *
 * TenkaCloud participant-portal plugin の public type surface。
 * 問題 (= problems/<id>/portal/) が export する React component の props を型で
 * 固める。portal はこれらの型に従って plugin slot を render する。
 *
 * peer dependency は React だけ。Cloudscape は portal 側が提供し、現在は build-time
 * integration により同じ bundle へ組み込む。
 *
 * MVP は **build-time integration** で動作する (= participant-portal が Vite の
 * `import.meta.glob` で problems/<id>/portal/ の .tsx を chunk 分割込みで取り込む)。
 * 別 S3 / 別 deploy からの URL-based loading は、bundle の二重化と import-map 対応が
 * 未解決のため提供しない。
 */

import type { ComponentType } from "react";

/**
 * Plugin slot に渡される共通 props。portal が問題の deployment / scoring / phase の
 * 状態を一括で plugin に渡す。
 *
 * fields:
 * - `team`: 自チームの基本情報。teamId / teamName / eventId。
 * - `problemId`: 問題 ID (= metadata.json の `id`)。同一 plugin が複数 problem 間で
 *    共有された場合の分岐 key (実用上は 1 problem 1 portal/ dir 想定)。
 * - `jobId`: deployment ULID。1 team が同 problem を複数 deploy した時の dedupe key。
 * - `score`: 現在の累積 score。
 * - `locale`: portal 本体の表示 locale。plugin 側の文言出し分けに使う。
 * - `posture` / `platform`: scoring probe が最後に観測した live posture snapshot。
 * - `endpoints`: 自チームの (slot, defaultUrl, overrideUrl, effectiveUrl)。
 * - `phases`: metadata.phases[] (= operator 内部 field なし、 predict 用)。
 * - `disruptions`: metadata.disruptions[] (= 同上)。
 * - `nowIso`: portal が plugin に「現在時刻」を渡す (= test 容易性 + clock skew 緩和)。
 */
export interface PortalSlotProps {
  readonly team: {
    readonly teamId?: string;
    readonly teamName: string;
    readonly eventId?: string;
  };
  readonly problemId: string;
  readonly jobId: string;
  readonly score: number;
  readonly locale: PortalLocale;
  readonly posture?: Readonly<Record<string, boolean>>;
  readonly platform?: string;
  readonly endpoints: readonly PortalEndpoint[];
  readonly phases: readonly PortalPhaseEntry[];
  readonly disruptions: readonly PortalDisruptionEntry[];
  /**
   * Issue #1420: 参加者間 coordination の公開情報 (= `publicHint: true` の問題のみ)。
   * 未宣言 / non-public な問題では undefined (= plugin 側で `props.coordination?.` で安全に扱う)。
   */
  readonly coordination?: PortalCoordinationEntry;
  /**
   * Issue #1420: team credential を使って coordination dispatcher を実際に呼び出す client。
   * portal が dispatcher URL (`coordinationApiUrl`) と session を持つときだけ束縛される。
   * 未配線または coordination 無効の問題では undefined。plugin は
   * `props.coordinationClient?.submitOp(op)` で op を送り、`getProjection()` で自チーム視点の
   * projection (live route directory など) を読む。
   */
  readonly coordinationClient?: PortalCoordinationClient;
  readonly nowIso: string;
}

export type PortalLocale = "ja" | "en";

/**
 * coordination op の結果 (= dispatcher の HTTP status を写した discriminated union)。 plugin は
 * `kind` で分岐する (ok=projection 反映 / rejected=理由表示 / not_configured・unavailable=機能オフ表示)。
 */
export type PortalCoordinationOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_configured" }
  | { readonly kind: "unauthorized" };

/**
 * team の credential に束縛済の coordination client (portal が注入)。 plugin は URL / token を知らずに
 * op 投入 + projection 取得ができる (= 認証は infra 層、 INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER 準拠)。
 */
export interface PortalCoordinationClient {
  readonly submitOp: (op: unknown) => Promise<PortalCoordinationOutcome>;
  readonly getProjection: () => Promise<PortalCoordinationOutcome>;
}

/**
 * 1 endpoint slot の状態。 default URL は metadata.endpoints[i].default.key + appendPath
 * から portal が deploy 後の CFn output を読んで計算する。 effective = override ?? default。
 */
export interface PortalEndpoint {
  readonly slot: string;
  readonly overridable: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly defaultUrl?: string;
  readonly overrideUrl?: string;
  readonly effectiveUrl?: string;
}

/**
 * Issue #689: `publicHint=true` の entry のみ portal に流す前提で plugin
 * は受け取る。 false / undefined は portal layer (= props-builder) で fail-closed に
 * filter される。 plugin 側で publicHint flag を見る必要は無い (= 既に絞り込み済が来る)。
 */
export interface PortalPhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly description?: string;
  readonly publicHint?: boolean;
}

export interface PortalDisruptionEntry {
  readonly id: string;
  readonly name: string;
  readonly defaultAfterMinutes?: number;
  readonly description?: string;
  readonly publicHint?: boolean;
}

/**
 * Issue #1420: 参加者間 coordination の公開情報。`publicHint=true` の問題のみ portal
 * (= props-builder) で narrow され plugin に届く。 plugin 側で publicHint を見る必要は無い。
 * plugin path 等の platform 内部 field は portal には流さない (= 表示用の name / description のみ)。
 */
export interface PortalCoordinationEntry {
  readonly name?: string;
  readonly description?: string;
}

/**
 * 1 slot に配置する component の型 alias。 problem 側 portal/<SlotName>.tsx は
 * `export default function StatusPanel(props: PortalSlotProps) {...}` の形で書く。
 *
 * 名前は metadata.json の `dashboard.slots[slotName]` で portal 側 slot 名に紐付ける。
 * 1 ファイル 1 slot 1 component (= portal lookup の正本は metadata の slot 名 → file path)。
 *
 * portal が予約する slot 名は {@link PORTAL_SLOT_NAMES} の literal 列挙を参照。
 */
export type PortalSlotComponent = ComponentType<PortalSlotProps>;

/**
 * 予約 slot 名の literal 列挙。 portal 側 / plugin 側で typo を防ぐため共有する。
 * 各 slot の意味:
 *   - StatusPanel       : 自チームの現在状態 (= endpoint 健全性 + phase countdown)
 *   - RegistrationPanel : endpoint override 登録 form (= 切り出した service URL を登録)
 *   - HelpDrawer        : 問題固有のヒント / 操作手順を出す drawer
 */
export const PORTAL_SLOT_NAMES = ["StatusPanel", "RegistrationPanel", "HelpDrawer"] as const;
export type PortalSlotName = (typeof PORTAL_SLOT_NAMES)[number];

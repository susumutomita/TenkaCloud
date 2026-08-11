// Issue #2950: `/developers/api/machine/` の chrome copy。
//
// site-copy.ts と同じ規律で、ja / en が同じ TypeScript の形を共有する。片方にしかない節を
// 書けないので、parity はレビューの心がけではなく型と test で保証される。
//
// spec そのもの (operation / schema) は生成物 `machine-api.generated.ts` にあり、ここには
// 一切書かない。ここにあるのは「この API は何で、なぜ Try-It が無いのか」だけである。

export interface MachineApiCopy {
  readonly meta: { readonly title: string; readonly description: string };
  readonly heading: string;
  readonly lead: string;
  readonly tryItHeading: string;
  readonly tryItBody: string;
  readonly reachHeading: string;
  readonly reachBody: string;
  readonly credentialHeading: string;
  readonly credentialBody: string;
  readonly tableHeading: string;
  readonly tableColumns: {
    readonly operation: string;
    readonly capability: string;
    readonly scope: string;
    readonly summary: string;
  };
}

export const MACHINE_API_COPY: { readonly ja: MachineApiCopy; readonly en: MachineApiCopy } = {
  ja: {
    meta: {
      title: "Machine API リファレンス",
      description:
        "CLI・CI・エージェントが machine credential で呼び出せる TenkaCloud Tenant API のリファレンス。",
    },
    heading: "Machine API リファレンス",
    lead: "CLI、CI、エージェントが machine credential で呼び出せる operation の一覧です。このページはプラットフォームの route table と検証スキーマから生成しています。",
    tryItHeading: "Try-It は無効です",
    tryItBody:
      "この API は sandbox ではなく実データを操作するため、ブラウザから直接呼び出す Try-It は提供しません。既定の server も解決できないホストにしてあり、このページから本番へ誤って送信することはできません。",
    reachHeading: "machine principal が到達できる範囲",
    reachBody:
      "machine credential の role は TenantMachine で、破壊的な操作の allowlist にはどれにも含まれません。したがって下の一覧がそのまま「machine credential で到達できる全て」です。障害注入、削除、チームログインキーの取得、管理系の操作は role の時点で到達できません。",
    credentialHeading: "credential の入手",
    credentialBody:
      "credential は運営者が scripts/issue-machine-client.sh で発行します。client secret は発行時に 1 度だけ表示され、どこにも保存されません。access token の有効期間は 15 分です。",
    tableHeading: "Operation 一覧",
    tableColumns: {
      operation: "Operation",
      capability: "Capability",
      scope: "必要な scope",
      summary: "概要",
    },
  },
  en: {
    meta: {
      title: "Machine API reference",
      description:
        "Reference for the TenkaCloud Tenant API operations a CLI, CI job, or agent can call with a machine credential.",
    },
    heading: "Machine API reference",
    lead: "The operations a CLI, CI job, or agent can call with a machine credential. This page is generated from the platform's own route table and validation schemas.",
    tryItHeading: "Try-It is disabled",
    tryItBody:
      "This API operates on real data, not a sandbox, so there is no in-browser Try-It. The default server also resolves nowhere, preventing this page from sending a request to production by accident.",
    reachHeading: "What a machine principal can reach",
    reachBody:
      "A machine credential carries the role TenantMachine, which appears in no destructive route's allowlist. The list below is therefore the complete surface reachable with a machine credential. Disruption injection, deletion, team login keys, and every admin operation are unreachable at the role level.",
    credentialHeading: "Getting a credential",
    credentialBody:
      "An operator issues credentials with scripts/issue-machine-client.sh. The client secret is shown once at issuance and stored nowhere. Access tokens live for 15 minutes.",
    tableHeading: "Operations",
    tableColumns: {
      operation: "Operation",
      capability: "Capability",
      scope: "Required scope",
      summary: "Summary",
    },
  },
};

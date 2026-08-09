---
name: machine write surface の拡張
about: machine (M2M) credential から到達できる route を追加する
title: 'feat(api): machine write surface に <route> を追加する'
labels: ['enhancement']
assignees: ''

---

## 追加する route

<!-- method + path + 必要 capability。既存 capability で足りるか、新設が要るかを書く。 -->

| method | path | capability |
| --- | --- | --- |
|  |  |  |

## 証拠ゲート (必須)

Phase 2 (Issue 2955) で決めた通り、route を machine に開くときは **その route が届く非同期経路** を証拠付きで示す。設計 C が `PATCH /events/{id}/schedule` で踏んだのがこの罠で、同期的には 1 field の書き込みに見える route が scheduler 経由で競技進行そのものを動かしていた。

- [ ] handler の実装を読み、publish する event と起動する job を列挙した
- [ ] `scheduler` / reconciler / 競技進行に届かないことを確認した (届くなら **開かない**)
- [ ] `MACHINE_ROUTE_SCOPES` の `reachability` と `reachabilityEvidence` に判断と根拠 (file 名) を書いた
- [ ] cross-tenant safety を確認した (caller の tenantId 外の行に触れないこと)
- [ ] tenant suspension が効かないことを踏まえてよい route か判断した (suspension は現状 machine に効かない)

`reachability` は必須 field なので、宣言し忘れた route は typecheck で落ちる。`scheduler` を宣言した route は test で落ちる。

## 経路の対称性

- [ ] human 側 gateway にも同じ route が配線されている (片方だけ到達できる状態を残さない)
- [ ] 新しい capability scope を足した場合、`MACHINE_CAPABILITIES` と発行 script の preset の両方を更新した

## role allowlist のレビュー

- [ ] `requireRole` に `TENANT_MACHINE_ROLE` を足した箇所を列挙した
- [ ] 足した箇所が `MACHINE_ROUTE_SCOPES` の mutating route と 1 対 1 で対応している (source-level test が件数を pin する)

## 監査

- [ ] 追加した mutating route が `writeAuditEvent` を呼ぶ
- [ ] 拒否経路が `outcome: "forbidden"` の行を残す

## 検証

- [ ] `make harness`
- [ ] `make before-commit`
- [ ] `make check-synth` と `Template.fromStack` assertion (infra を触った場合)
- [ ] `make openapi` を実行し、生成物の差分を commit した

## Physical impact

<!-- CREATE / UPDATE / REPLACE / DELETE / NO-OP。human 側 gateway に method を足す場合は
     全 tenant stack への CREATE になる。 -->

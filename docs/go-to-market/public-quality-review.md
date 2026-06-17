# 公開品質レビュー

| 項目 | 内容 |
|---|---|
| Tracking issue | [#1864](https://github.com/susumutomita/TenkaCloud/issues/1864) |
| レビュー日 | 2026-06-17 |
| 参照チェックリスト | [Web サービス公開前のチェックリスト](https://zenn.dev/catnose99/articles/547cbf57e5ad28) |
| 対象 | landing / docs / admin-console / application-admin-console / participant-portal / API / Cognito / CloudFront / S3 / Lambda / DynamoDB / 通知 |
| 決済 | TenkaCloud 本体に決済導線が無いため対象外。将来の有料申込・請求は別レビュー対象。 |

このレビューは外部公開、コミュニティ配布、デモ利用の前に確認すべき公開品質を棚卸しする。
インフラ実装の変更は AGENTS.md の役割分担に従い、この PR では行わない。必要な変更は
Issue に分解し、アプリ / docs / scripts で完結するものから順に対応する。

## 判定

| 判定 | 意味 |
|---|---|
| OK | 現状の repo に実装、テスト、または運用ドキュメントの証跡がある。 |
| Accepted risk | 現状仕様として明示的に受け入れている。外部説明に残す必要がある。 |
| Follow-up | 公開前に個別 Issue で対応する。 |
| N/A | 現時点の TenkaCloud に該当機能がない。理由を明記する。 |

## 外部デモ / コミュニティ配布前の blocker

| 優先 | Blocker | 対応 |
|---|---|---|
| P0 | 3 つの SPA entrypoint が config 読み込み失敗時に `root.innerHTML` へ `err.message` を埋め込む。通常フローではないが、公開前品質として raw HTML sink を残さない。 | [#1866](https://github.com/susumutomita/TenkaCloud/issues/1866) |
| P0 | public-release の browser / responsive / keyboard / modal focus / long-name / basic performance smoke の証跡が 1 箇所に無い。Unit test は厚いが、外部デモ前の実機観点が残っていない。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| P1 | landing は title / description / 一部 OGP を持つが、canonical / `og:url` / `og:image` / `twitter:card` / favicon / apple-touch-icon が未整備。docs 生成 HTML は `lang` と metadata が不足するページがある。 | [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867) |
| P1 | paid event / public demo の復旧姿勢として、DynamoDB / S3 / runtime-config / catalog / audit log の backup / restore 方針が 1 箇所にまとまっていない。 | [#1869](https://github.com/susumutomita/TenkaCloud/issues/1869) |

## 既存 Issue と重複させない項目

| 項目 | 既存 Issue | 今回の扱い |
|---|---:|---|
| 競技者へのメール招待、SES、招待メール導線 | [#1778](https://github.com/susumutomita/TenkaCloud/issues/1778) / [#1769](https://github.com/susumutomita/TenkaCloud/issues/1769) | メール基盤は現時点で N/A。実装時に SPF / DKIM / DMARC、列挙防止、再送制御を同時に確認する。 |
| セルフサービスサインアップ | [#1774](https://github.com/susumutomita/TenkaCloud/issues/1774) | 現状は operator 管理前提。公開 signup を追加する時に本人確認と列挙防止を再レビューする。 |
| Application Admin Console の viewer / editor subrole | [#1771](https://github.com/susumutomita/TenkaCloud/issues/1771) | 現状の tenant / participant 境界は API 側で守る。細粒度 subrole は既存 Issue 側で扱う。 |
| Operations page | [#1770](https://github.com/susumutomita/TenkaCloud/issues/1770) | CloudWatch / runbook はある。in-app の運用導線は既存 Issue 側で扱う。 |

## セキュリティ

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| 認証 Cookie / token 保存 | OK / Accepted risk | admin / application-admin は Cognito Hosted UI + OAuth Code + PKCE。`packages/auth-client/src/cognito.ts` と `packages/web-kit/src/auth.tsx` は bearer token を storage に永続化せず React state に保持する。PKCE verifier / OAuth state のみ `sessionStorage`。participant は Cognito ではなく `teamLoginKey` を bearer とし、`apps/participant-portal/src/auth/storage.ts` が TTL 付きセッションを `localStorage` に保存する。競技 UX を優先した accepted risk。 | participant の key 配布と期限は pre-event runbook で運用確認する。 |
| app-owned Cookie 属性 | N/A | TenkaCloud SPA は app-owned auth Cookie を発行しない。Cookie は Cognito Hosted UI 側の管理対象。 | BFF / HttpOnly Cookie 方式へ移行する場合は ADR-025 の後続として再レビューする。 |
| Server-side validation | OK | API README は Hono handler の Zod schema と OpenAPI 同期を要求する。handler tests でも validation / 404 / 401 / 422 を pin している。 | 新 route 追加時は同じ pattern を維持する。 |
| URL protocol / Markdown HTML | OK | `packages/web-kit/src/markdown.tsx` は DOMPurify allowlist と `ALLOWED_URI_REGEXP` で `javascript:` / `data:` / `vbscript:` / `file:` を拒否する。`dangerouslySetInnerHTML` は sanitized markdown component に閉じ込めている。 | raw HTML sink は [#1866](https://github.com/susumutomita/TenkaCloud/issues/1866) で削除する。 |
| 認可境界 | OK / Roadmap | `docs/api/README.md` は Control / Tenant / Participant の plane を分離し、tenant mismatch を 404 として扱う。participant API は `teamLoginKey` owner の team scope に閉じる。 | granular subrole は [#1771](https://github.com/susumutomita/TenkaCloud/issues/1771)。 |
| Response headers | OK | CloudFront は `infrastructure/lib/security/cloudfront-headers.ts` で HSTS / CSP / `frame-ancestors 'none'` / `X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` を定義。API は `secureApiHeaders` で `nosniff` / `DENY` / `strict-origin-when-cross-origin` / `no-store` を付与。 | インフラ変更はユーザー責務。現状は証跡のみ記録。 |
| Cache | OK | API security headers は route が明示しない限り `Cache-Control: no-store`。CloudFront SPA は static asset 配信、runtime-config は security docs で `no-store` / `nosniff` を要求している。 | 共有 cache 可能な API を増やす場合は route 単位で opt-out を明記する。 |
| Error display | Follow-up | Backend は 5xx を `{ "error": "internal_error" }` に落とし、stack trace を browser に出さない方針。SPA config-load fallback は `innerHTML` で `err.message` を出す。 | [#1866](https://github.com/susumutomita/TenkaCloud/issues/1866) |
| File upload | N/A | 競技者 / 管理者による任意ファイル upload 導線は現状ない。problem catalog は repo / template validation の管理対象。 | upload 機能を追加する時に MIME / size / AV / signed URL を別レビューする。 |
| SQL injection | N/A | SQL DB を使わない。主要永続化は DynamoDB と S3。 | SQL datastore を追加する時に再レビューする。 |
| バックアップ / restore | Follow-up | incident / teardown / dry-run runbook はあるが、platform data と object storage の backup / restore posture は 1 箇所にまとまっていない。 | [#1869](https://github.com/susumutomita/TenkaCloud/issues/1869) |

## ログイン / アカウント管理

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| メールアドレス本人確認 | OK / Roadmap | admin 系は Cognito Hosted UI 前提。participant は per-team login key であり email identity ではない。 | email invite / signup を追加する [#1778](https://github.com/susumutomita/TenkaCloud/issues/1778) / [#1774](https://github.com/susumutomita/TenkaCloud/issues/1774) で再確認する。 |
| メールアドレス列挙 | N/A / Roadmap | 現状の participant login は email を使わない。admin local Cognito / SAML は Cognito / IdP 側の認証画面。 | invite / signup 実装時に列挙防止を acceptance criteria に含める。 |
| 複数 IdP / SAML | OK | `docs/operations/application-plane-saml-setup.md` と `docs/operations/control-plane-saml-setup.md` が IdP setup を分ける。Cognito Hosted UI の `identity_provider` 指定も shared client に実装済み。 | 既存 setup docs を event runbook から参照する。 |
| 招待リンクの期限 / 再利用 | OK / Roadmap | participant `teamLoginKey` は deployment / event の `expiresAt` に従う。再利用はチーム scope 内の bearer として許可される accepted risk。 | email invite の one-time / expiry semantics は [#1778](https://github.com/susumutomita/TenkaCloud/issues/1778)。 |

## メール / 通知

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| SPF / DKIM / DMARC | N/A | 現状は外部 email 送信基盤を持たない。participant 通知は portal polling。 | [#1778](https://github.com/susumutomita/TenkaCloud/issues/1778) で SES を入れる時に設定方針を必須化する。 |
| 重複送信 / at-least-once | OK / Roadmap | `docs/operations/notifications.md` は in-portal 通知を pull 型、編集 / 削除なし、DDB TTL で保持と定義する。メール再送は未実装。 | email / EventBridge 配信を増やす場合は idempotency key を acceptance criteria にする。 |
| ユーザー入力の通知本文 | OK | 通知本文は React / Cloudscape で text として表示される。HTML notification は提供しない。 | 将来 rich text 通知を入れる場合は Markdown sanitizer を共有する。 |
| unsubscribe / List-Unsubscribe | N/A | キャンペーン email が無い。 | marketing email を実装する時に別レビュー。 |

## SEO / OGP / LP

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| LP title / description | OK | `landing/index.html` は title / description / partial OGP を持つ。 | 追加 metadata は [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867)。 |
| canonical / OGP / Twitter / favicon | Follow-up | `landing/index.html` に canonical / `og:url` / `og:image` / `twitter:card` / icon が無い。`rg` でも favicon / apple-touch-icon asset は見つからない。 | [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867) |
| docs metadata / lang | Follow-up | `scripts/build-docs.ts` は markdown 生成 HTML を一律 `<html lang="ja">` にする。英語 docs でも `lang="ja"` になるものがある。 | [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867) |
| noindex | OK / Follow-up | `rg "noindex"` では公開面に残存 noindex は見つからない。auth-only SPA shell の index policy は未明記。 | [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867) |

## Accessibility

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| icon-only button / link label | Partial | Cloudscape component を中心に構成され、一部 custom link は `aria-label` を持つ。全画面横断の evidence は無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| 画像 alt | Partial | Markdown sanitizer は `alt` attribute を許可し、landing の hero chart は `role="img"` / `aria-label` を持つ箇所がある。全 public docs / landing asset の監査 evidence は無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| keyboard / modal focus / toast | Partial | Cloudscape Modal / Alert を多用しているが、外部デモ前の keyboard-only smoke matrix が無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| 色だけに依存しない状態表示 | Partial | StatusBadge / Alert / textual labels が多いが、長い event / team / problem 名と組み合わせた横断 smoke が無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |

## Performance

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| bundle size / 巨大 JS | Partial | Build は Vite / Bun で実行される。EventReport は bundle size を抑えるため PDF library を避けるなど局所判断はある。横断的な public-release 観測値は無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| CDN cache | OK | SPA / docs / landing は CloudFront / static HTML 配信前提。API は user-specific response を `no-store`。 | runtime-config / auth-only surface の cache policy は infra evidence と一緒に維持する。 |
| Image / CLS | Partial | landing は SVG / canvas / embedded UI mock を使う。Lighthouse / visual smoke の evidence は無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| API / DB access pattern | OK / Roadmap | DynamoDB capacity / scan pressure は `docs/runbooks/capacity-pressure.md` と observability docs で扱う。主要 API は tenant / event / team scope の Query を基本にしている。 | 新しい heavy query は harness / tests / runbook で pin する。 |

## 複数環境 / ブラウザ

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| mobile / tablet / desktop | Follow-up | 各 SPA は responsive component を使うが、公開前 smoke matrix が無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| Chrome / Safari / Firefox | Follow-up | EventReport exporter などに Safari / Firefox 配慮の局所コメントはあるが、主要導線の横断 evidence は無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| Mac / Windows scrollbar / font | Follow-up | Cloudscape / system font 前提。OS 横断確認の記録が無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| 長い event / team / problem / user name | Follow-up | 一部 tests は長い tenant name を扱うが、主要画面の横断 visual smoke は無い。 | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |

## 運用 / 監視

| チェック | 判定 | 現状と証跡 | 対応 |
|---|---|---|---|
| 5xx / auth error / frontend error detection | OK / Roadmap | `docs/operations/observability.md` は CloudWatch metrics / Logs Insights / suggested alarms を定義。`infrastructure/lib/observability/free-tier-alarms.ts` は Lambda Errors / API Gateway 5XX alarms を持つ。frontend error aggregation は未導入。 | in-app Operations UX は [#1770](https://github.com/susumutomita/TenkaCloud/issues/1770)。frontend error collection を入れる場合は別 Issue。 |
| CloudWatch Logs / Metrics / Alarm | OK | observability docs、capacity-pressure runbook、incident-response runbook がある。 | paid event 前は pre-event checklist の T-0 で dashboard を開く。 |
| イベント中の異常把握導線 | OK / Roadmap | pre-event / live-monitoring / incident-response / deploy-trace docs がある。admin-console 側の Operations page は既存 Issue。 | [#1770](https://github.com/susumutomita/TenkaCloud/issues/1770) |
| 404 / 50x pages | Partial | SPA CloudFront は 403 / 404 を `/index.html` に fallback する。API は machine-readable error を返す。static docs / landing の custom 404 / 50x UX は未整理。 | [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867) で public metadata / static site policy と一緒に扱う。 |

## Evidence commands

レビューでは以下の観点を repo 上で確認した。

```bash
rg "dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage" apps packages infrastructure docs
rg "Strict-Transport-Security|Content-Security-Policy|X-Content-Type-Options|Referrer-Policy" infrastructure docs
rg "meta name=\"description\"|property=\"og:|twitter:card|canonical|favicon|apple-touch-icon|<html lang" apps docs landing
rg "aria-label|<button|<a |alt=|Modal|Alert" apps packages
rg "backup|restore|CloudWatch|5xx|404|50x" docs infrastructure
gh issue list --state open
```

## Review result

公開前レビューとして、現状の TenkaCloud は private demo / controlled community validation へ進める
だけの core architecture evidence を持っている。一方で、広い public launch や paid event の前には
次の順で潰す。

1. [#1866](https://github.com/susumutomita/TenkaCloud/issues/1866) で raw HTML fallback を消す。
2. [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) で browser / accessibility /
   responsive / performance smoke の再現可能な証跡を作る。
3. [#1867](https://github.com/susumutomita/TenkaCloud/issues/1867) で public metadata と static site
   policy を整える。
4. [#1869](https://github.com/susumutomita/TenkaCloud/issues/1869) で backup / restore posture を
   paid event の判断材料として明文化する。

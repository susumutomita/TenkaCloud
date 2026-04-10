# 技術的負債バックログ

> このファイルは `scripts/ai-improvement-loop.ts --write` で更新する。

## サマリー

- Critical: 23
- High: 59
- Medium: 72
- Total: 154

## 優先アクション

1. apps/application-plane/app/api/admin/analytics/route.ts: 一時しのぎの fallback が残っている。空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。
2. apps/application-plane/app/api/admin/dashboard/stats/route.ts: 一時しのぎの fallback が残っている。空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。
3. apps/application-plane/app/api/admin/events/route.ts: 一時しのぎの fallback が残っている。空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。
4. apps/application-plane/app/api/admin/participants/route.ts: 一時しのぎの fallback が残っている。空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。
5. apps/application-plane/app/api/admin/problems/[id]/route.ts: 一時しのぎの fallback が残っている。空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

## ホットスポット

| File | Score | Findings | Highest |
| --- | ---: | ---: | --- |
| `backend/services/application-plane/problem-service/src/routes/participant.ts` | 33 | 2 | critical |
| `apps/application-plane/app/api/admin/analytics/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/admin/dashboard/stats/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/admin/events/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/admin/participants/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/admin/problems/[id]/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/admin/problems/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/admin/teams/route.ts` | 29 | 2 | critical |
| `apps/application-plane/app/api/participant/rankings/route.ts` | 24 | 2 | critical |
| `apps/application-plane/app/(admin)/admin/events/[eventId]/problems/[problemId]/deployments/page.tsx` | 18 | 2 | high |
| `apps/application-plane/app/events/[eventId]/page.tsx` | 18 | 2 | high |
| `backend/services/application-plane/problem-service/src/__tests__/routes-participant.test.ts` | 18 | 2 | critical |
| `apps/application-plane/app/(participant)/gameday/[eventId]/alliance/page.tsx` | 16 | 2 | high |
| `apps/application-plane/app/(participant)/gameday/[eventId]/vote/page.tsx` | 16 | 2 | high |
| `backend/services/application-plane/gameday-service/src/api/participant.test.ts` | 15 | 2 | critical |

## Findings

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/analytics/route.ts:180`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/dashboard/stats/route.ts:88`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/events/route.ts:130`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/participants/route.ts:98`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/problems/[id]/route.ts:91`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/problems/route.ts:77`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/admin/teams/route.ts:93`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `apps/application-plane/app/api/participant/rankings/route.ts:1`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### 一時しのぎの fallback が残っている

- File: `backend/services/application-plane/problem-service/src/routes/participant.ts:146`
- Severity: critical
- Category: correctness
- Summary: empty dataset / stub を返す実装は障害を隠し、利用者には成功に見えるまま機能不全を固定化する。
- Recommendation: 空データで握り潰さず、正しい fallback service を実装するか、未対応として明示的に失敗させる。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/repositories/gameday-repository.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1524 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/routes/admin.ts:1`
- Severity: critical
- Category: module-boundary
- Summary: 3274 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/routes/participant.ts:1`
- Severity: critical
- Category: module-boundary
- Summary: 1611 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/control-plane/tenant-management/src/index.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1058 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/shared/dynamodb/src/types.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1078 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(admin)/admin/events/[eventId]/problems/[problemId]/deployments/page.tsx:137`
- Severity: high
- Category: boundary
- Summary: UI ファイル内で fetch を 6 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(admin)/admin/gameday/[eventId]/dashboard/page.tsx:56`
- Severity: high
- Category: boundary
- Summary: UI ファイル内で fetch を 4 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI がサービス URL を直接参照している

- File: `apps/application-plane/app/(participant)/gameday/[eventId]/alliance/page.tsx:85`
- Severity: high
- Category: boundary
- Summary: UI が API URL を直接読むと、環境差分と fallback 方針が画面単位で分岐してしまう。
- Recommendation: backend URL の解決は API client/helper に閉じ込め、画面から環境変数参照を排除する。

### UI がサービス URL を直接参照している

- File: `apps/application-plane/app/(participant)/gameday/[eventId]/vote/page.tsx:39`
- Severity: high
- Category: boundary
- Summary: UI が API URL を直接読むと、環境差分と fallback 方針が画面単位で分岐してしまう。
- Recommendation: backend URL の解決は API client/helper に閉じ込め、画面から環境変数参照を排除する。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/events/[eventId]/page.tsx:181`
- Severity: high
- Category: boundary
- Summary: UI ファイル内で fetch を 3 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/api/admin.test.ts:1`
- Severity: critical
- Category: module-boundary
- Summary: 1243 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/api/participant.test.ts:1`
- Severity: critical
- Category: module-boundary
- Summary: 1641 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/services/participant-service.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 952 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/aws-gameday-provider.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 994 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/routes-admin.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 2216 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/routes-participant.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1617 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/scoring-service/src/services/scoring.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1345 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/control-plane/tenant-management/src/index.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1480 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/control-plane/user-management/src/__tests__/users.test.ts:1`
- Severity: critical
- Category: maintainability
- Summary: 1021 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/analytics/route.ts:180`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/dashboard/stats/route.ts:88`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/events/[eventId]/route.ts:38`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/events/route.ts:130`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/participants/route.ts:98`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/problems/[id]/route.ts:26`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/problems/route.ts:77`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/settings/route.ts:57`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### route handler に fallback が重複している

- File: `apps/application-plane/app/api/admin/teams/route.ts:93`
- Severity: high
- Category: fallback
- Summary: route 単位で fallback を持つと、同じエラー条件でも戻り値とログ方針がずれやすい。
- Recommendation: fallback 判定は feature service に寄せ、route handler は HTTP 変換だけに薄く保つ。

### アサーションルーレットが発生している

- File: `apps/application-plane/__tests__/auth.test.ts:50`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 8 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/__tests__/page.test.tsx:57`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 8 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/analytics/__tests__/page.test.tsx:51`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 8 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/events/__tests__/use-event-form-state.test.ts:19`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 8 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `apps/application-plane/app/(admin)/admin/events/[eventId]/problems/[problemId]/deployments/page.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 734 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `apps/application-plane/app/(admin)/admin/gameday/[eventId]/page.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 732 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `apps/application-plane/app/(admin)/admin/marketplace/page.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 823 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/api/auth/[...nextauth]/__tests__/route.test.ts:44`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 9 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `apps/application-plane/app/events/[eventId]/challenges/[challengeId]/page.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 801 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `apps/application-plane/app/events/[eventId]/page.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 702 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `apps/application-plane/components/admin/__tests__/event-form.test.tsx:48`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 12 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `apps/application-plane/components/admin/problem-form.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 610 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `apps/application-plane/components/ui/__tests__/table.test.tsx:22`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 8 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `apps/application-plane/lib/i18n.tsx:1`
- Severity: high
- Category: maintainability
- Summary: 652 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `apps/application-plane/lib/notifications/__tests__/context.test.tsx:18`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 8 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/lib/tenant/__tests__/identification.test.ts:30`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 10 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/types/__tests__/tenant.test.ts:17`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 12 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/api/participant.ts:1`
- Severity: high
- Category: module-boundary
- Summary: 769 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/services/participant-service.ts:1`
- Severity: high
- Category: maintainability
- Summary: 635 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/challenge.test.ts:31`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 15 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/contest.test.ts:45`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 10 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/converter.test.ts:70`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 11 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/eventlog.test.ts:41`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 11 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/routes-participant.test.ts:111`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 9 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/problems/converter.ts:1`
- Severity: high
- Category: maintainability
- Summary: 641 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/providers/aws/index.ts:1`
- Severity: high
- Category: maintainability
- Summary: 639 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/repositories/problem-repository.ts:1`
- Severity: high
- Category: maintainability
- Summary: 638 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/scoring/providers/aws-gameday.ts:1`
- Severity: high
- Category: maintainability
- Summary: 799 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/scoring/realtime-engine.ts:1`
- Severity: high
- Category: maintainability
- Summary: 683 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `backend/services/control-plane/system-management/src/services/metrics.test.ts:35`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 11 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/control-plane/tenant-management/src/middleware/audit.test.ts:65`
- Severity: high
- Category: test-quality
- Summary: 単一テストケースに expect が 10 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### モジュールが大きすぎる

- File: `backend/services/shared/dynamodb/src/event-repository.ts:1`
- Severity: high
- Category: maintainability
- Summary: 882 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `packages/core/src/aws/aws/index.ts:1`
- Severity: high
- Category: maintainability
- Summary: 636 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `packages/core/src/scoring/providers/aws-gameday.ts:1`
- Severity: high
- Category: maintainability
- Summary: 797 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `packages/core/src/scoring/realtime-engine.ts:1`
- Severity: high
- Category: maintainability
- Summary: 683 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(admin)/admin/events/page.tsx:109`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(admin)/admin/marketplace/page.tsx:165`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 2 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(admin)/admin/participants/page.tsx:54`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(admin)/admin/teams/page.tsx:41`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(participant)/gameday/[eventId]/alliance/page.tsx:87`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(participant)/gameday/[eventId]/layout.tsx:127`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/(participant)/gameday/[eventId]/vote/page.tsx:42`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/onboarding/page.tsx:78`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### UI レイヤーが直接 fetch している

- File: `apps/application-plane/app/onboarding/provisioning/page.tsx:51`
- Severity: medium
- Category: boundary
- Summary: UI ファイル内で fetch を 1 箇所使っており、認証・fallback・例外処理が散りやすい。
- Recommendation: lib/api または server helper に集約し、UI からはユースケース関数だけを呼ぶ。

### モジュールが大きすぎる

- File: `backend/services/application-plane/battle-service/src/services/battle.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 752 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/gameday-service/src/services/auditor-service.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 611 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/converter.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 874 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/jam-scoring.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 662 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/problem-deployer.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 701 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/realtime-engine.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 705 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/scoring-engine.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 718 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/application-plane/problem-service/src/__tests__/validator.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 613 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/control-plane/deployment-management/src/api/deployments.test.ts:1`
- Severity: high
- Category: module-boundary
- Summary: 732 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### モジュールが大きすぎる

- File: `backend/services/control-plane/deployment-management/src/services/deployment.test.ts:1`
- Severity: high
- Category: maintainability
- Summary: 634 行あり、責務分離なしでは変更衝突とレビュー負荷が増える。
- Recommendation: 責務単位で分割し、API 定義・バリデーション・サービス・変換処理を別モジュールへ切り出す。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/events/[eventId]/__tests__/page.test.tsx:48`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/events/new/__tests__/page.test.tsx:21`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/problems/[id]/deploy/__tests__/page.test.tsx:32`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/problems/[id]/edit/__tests__/page.test.tsx:61`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(admin)/admin/problems/new/__tests__/page.test.tsx:21`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/(participant)/gameday/[eventId]/tutorial/__tests__/page.test.tsx:23`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/api/admin/analytics/__tests__/route.test.ts:39`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/onboarding/provisioning/__tests__/page.test.tsx:20`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/app/rankings/__tests__/page.test.tsx:54`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/components/ui/__tests__/alert-dialog.test.tsx:22`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/components/ui/__tests__/pagination.test.tsx:12`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/lib/__tests__/i18n.test.tsx:46`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/lib/api/__tests__/backend-urls.test.ts:12`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/application-plane/lib/aws/__tests__/sts-federation.test.ts:68`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/__tests__/auth.test.ts:51`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/app/dashboard/tenants/__tests__/page.test.tsx:152`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/app/dashboard/tenants/[id]/edit/__tests__/page.test.tsx:73`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/components/__tests__/theme-sync.test.tsx:54`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/components/tenants/__tests__/tenant-list.test.tsx:135`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/components/ui/__tests__/card.test.tsx:15`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/components/ui/__tests__/table.test.tsx:17`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/lib/api/__tests__/mock-tenant-api.test.ts:13`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 7 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/lib/api/__tests__/tenant-api-client.test.ts:13`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/lib/api/__tests__/tenant-api-server.test.ts:13`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `apps/control-plane/lib/theme.test.ts:43`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/gameday-service/src/api/participant.test.ts:204`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/gameday-service/src/services/dashboard-service.test.ts:52`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/leaderboard-service/src/api/gameday-leaderboard.test.ts:38`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/leaderboard-service/src/services/gameday-leaderboard.test.ts:30`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 7 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/leaderboard-service/src/services/leaderboard.test.ts:51`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/auth.test.ts:22`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/aws-gameday-provider.test.ts:66`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/competitor-account-repository.test.ts:29`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/dashboard.test.ts:33`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/event-lifecycle.test.ts:12`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/event-repository.prisma.test.ts:82`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/event-repository.test.ts:45`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/local-provider.test.ts:25`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/prisma-template-repository.test.ts:79`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/problem-deployer.test.ts:137`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/realtime-engine.test.ts:118`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 7 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/routes-player.test.ts:66`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/problem-service/src/__tests__/scoring-engine.test.ts:85`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/scoring-service/src/api/scores.test.ts:65`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/application-plane/scoring-service/src/services/scoring.test.ts:63`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/control-plane/system-management/src/services/health.test.ts:27`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/control-plane/tenant-management/src/index.test.ts:122`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 6 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/control-plane/user-management/src/__tests__/users.test.ts:130`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `backend/services/shared/dynamodb/src/tenant-repository.test.ts:42`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `packages/shared/src/quality/__tests__/tech-debt-loop.test.ts:8`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 7 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `packages/shared/src/types/__tests__/scoring.test.ts:12`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### アサーションルーレットが発生している

- File: `tmp/tenkacloud-pr349-fix/backend/services/application-plane/problem-service/src/__tests__/local-provider.test.ts:25`
- Severity: medium
- Category: test-quality
- Summary: 単一テストケースに expect が 5 個あり、失敗原因が読み取りにくい。
- Recommendation: 観点ごとにテストを分割し、1 ケース 1 失敗理由に近づける。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/application-plane/app/api/auth/[...nextauth]/route.ts:6`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/application-plane/app/api/participant/events/me/route.ts:50`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/application-plane/app/api/participant/events/route.ts:61`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/application-plane/app/api/participant/rankings/route.ts:42`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/application-plane/components/providers.tsx:10`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/application-plane/lib/auth/get-auth-token.ts:4`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/control-plane/e2e/auth.spec.ts:6`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/control-plane/e2e/dashboard.spec.ts:6`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `apps/control-plane/playwright.config.ts:6`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `backend/services/application-plane/problem-service/src/server.ts:29`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

### AUTH_SKIP 判定が責務境界の外へ漏れている

- File: `packages/shared/src/quality/tech-debt-loop.ts:69`
- Severity: medium
- Category: auth
- Summary: 認証バイパスの条件分岐が散ると、本番ガードとローカル挙動がファイルごとにずれやすい。
- Recommendation: AUTH_SKIP 判定は shared helper / middleware に閉じ込め、呼び出し側は結果だけを使う。

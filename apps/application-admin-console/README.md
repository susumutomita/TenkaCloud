# @TenkaCloud/application-admin-console

テナント開発者向けの管理 UI (Layer 2B)。1 Tenant : 1 deploy。テナント開発者がバイブコーディングしたアプリを登録し、認証付き公開を管理するためのコンソール。

## ローカル開発

このディレクトリで以下を実行する。

```sh
make install
make dev
# → http://localhost:5174
```

`make help` で利用可能なターゲット一覧を表示。

## コマンド

```sh
make dev      # 開発サーバ
make build    # 型チェック + 本番ビルド
make preview  # dist/ を serve
make test     # vitest
make clean    # dist と node_modules を削除
```

モノレポ全体から実行する場合。

```sh
bun run --filter @TenkaCloud/application-admin-console dev
bun run --filter @TenkaCloud/application-admin-console test
```

## 関連

- [`docs/architecture/00-system-context.md`](../../docs/architecture/00-system-context.md) Layer 2B
- 親 Issue: [#39](https://github.com/maishu-kobo/TenkaCloud/issues/39) Layer 2B 全体
- [#45](https://github.com/maishu-kobo/TenkaCloud/issues/45) (#39-a) 本スキャフォルド
- [#46](https://github.com/maishu-kobo/TenkaCloud/issues/46) (#39-b) silo モード配備
- [#47](https://github.com/maishu-kobo/TenkaCloud/issues/47) (#39-c) Cognito 認証ゲート
- [#48](https://github.com/maishu-kobo/TenkaCloud/issues/48) (#39-d) tenantId inject

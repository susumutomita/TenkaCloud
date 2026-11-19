# Terraform 演習の主催者用実行基盤（第1段階）

`bun scripts/tenkacloud.ts terraform` は、主催者がレビューした固定 bundle を専用のローカル状態領域に準備し、plan と承認済み apply を分けて実行する CLI です。

**まだ host / 問題カタログ / 参加者画面 / 採点と接続されていません。** Terraform や kintone を大会ランタイムとして対応済みとは扱いません。実 kintone テナントの動作確認も別途必要です。

## 信頼境界

- 信頼済み主催者の単一 OS アカウント専用。参加者、第三者のコードやアップロードを受け付けるサービスではない。OS レベルのサンドボックスではない。
- 主催者は Terraform binary、provider binary、lockfile、設定、ACL、配置先をレビューする。SHA は内容一致を示すだけで安全性の証明ではない。provider は任意の実行コードである。
- `tenant/event/team/problem/generation` を全て指定し、組合せごとに別の private ディレクトリ・ローカル state を維持する。scope 名は管理用ラベルであり、kintone 内のアクセス境界を自動作成しない。チームごとの実アカウントと ACL の分離は主催者が確保する。
- kintone の実 origin は `prepare --endpoint` に固定し、plan/apply の `KINTONE_BASE_URL` が異なれば拒否する。plan 時の username も apply 時に照合する。password を journal/config へ明示保存しない。ただし provider の診断や plan/state に秘密が含まれ得るため、private 領域全体を機密として扱う。
- 親プロセスの TF_*、AWS 資格情報、proxy、PATH、個人の Terraform 設定は引き継がない。kintone bundle のみ `KINTONE_BASE_URL/KINTONE_USERNAME/KINTONE_PASSWORD` を渡す。
- plan、state、診断ログには秘密が含まれ得る。private root は 0700、作成ファイルは 0600（実行用 mirror は 0700）。共有・Git 登録は禁止。state の安全なバックアップ、保存期間、暗号化ディスクは運用側で確保する。

## bundle 契約

root に `main.tf.json` と `.terraform.lock.hcl`、kintone provider を使う場合は `mirror/` だけを置きます。symlink、既存 state、HCL、追加設定ファイルは受け付けません。

- Terraform の `required_version` は `= 1.14.8` のように完全固定。
- builtin `terraform_data` は `input` のみ。外部 provider 不要。
- `kintone_app` は `name`, `description`, `rights` のみ。`retain_on_destroy` は禁止。
- kintone provider source は `susumutomita/kintone`、version は完全固定。`provider.kintone` は空で、資格情報・endpoint を設定に埋め込まない。
- module、data、backend、provisioner、変数、output、式 `${…}` / `%{…}` は禁止。
- provider 配布にはレビュー済み [filesystem mirror](https://developer.hashicorp.com/terraform/cli/config/config-file#filesystem_mirror) と lockfile が必要。CLI は `direct` fallback を設定せず、`init -lockfile=readonly` を plan 前と apply 直前に実行し、インストール済み provider の checksum も再確認する。provider の Registry 公開を前提にしない。
- `mirror` を含む全ファイルとパスを SHA に含め、実行前にコピーの一致を確認する。

## ローカルだけで縦通しする例

Terraform 1.14.8 の **実バイナリの絶対パス**を指定します。mise 等の shim は使いません。以下は builtin resource だけで、外部サービスを変更しません。

```sh
TF=/absolute/path/to/terraform
BUNDLE="$PWD/scripts/tests/fixtures/terraform-builtin"
# ファイルとbinaryを先にレビューする。SHA取得はレビューの代わりではない。
BUNDLE_SHA=$(bun scripts/tenkacloud.ts terraform digest --bundle "$BUNDLE")
TF_SHA=$(shasum -a 256 "$TF" | cut -d ' ' -f 1)
# rootの親ディレクトリは実在し、symlinkを含まない絶対パスを使う。
ROOT="$HOME/tenkacloud-terraform-state"
SCOPE=(--root "$ROOT" --tenant offline --event demo --team team1 --problem builtin --generation 1)
bun scripts/tenkacloud.ts terraform prepare "${SCOPE[@]}" \
  --bundle "$BUNDLE" --reviewed-sha "$BUNDLE_SHA" --binary "$TF" --binary-sha "$TF_SHA"
bun scripts/tenkacloud.ts terraform plan "${SCOPE[@]}"
bun scripts/tenkacloud.ts terraform status "${SCOPE[@]}"
# status の scopeId が <scope-hash>。
# ROOT/<scope-hash>/work/approved.tfplan をローカルで terraform show してレビュー。
# 生のplan/state/diagnosticはチャットや共有ログに貼り付けない。
bun scripts/tenkacloud.ts terraform apply "${SCOPE[@]}" --approve-plan <表示されたSHA256>
```

kintone bundle は prepare に `--endpoint https://your-tenant.cybozu.com` を追加し、実行時だけ環境変数で認証します。実テナント操作前に対象、完全 ACL、管理者権限維持、全 pending app 設定の deploy への影響を確認してください。現在の provider は fields/records、採点、テナント作成・削除を担いません。

## 失敗、再開、リセット

- 同じ scope の並行操作は `operation.lock` で拒否する。プロセスが落ちても lock を自動破棄しない。稼働プロセスと remote outcome を調べるまで解除は禁止。
- journal は prepared → planning → planned → applying → applied。plan 失敗は plan_failed（再 plan 可）。apply 失敗は apply_failed。apply_failed/applying/applied からの自動再 apply は拒否する。
- state、plan、provider の診断は private ディレクトリに保持する。診断 `work/diagnostic-*.log` には秘密が含まれ得る。端末への生出力はしない。
- prepare 中断後の bundle も上書きしない。運用者が状態を調べてから手動対応する。失敗時に新 generation を作って再 apply することは二重作成の恐れがある。
- destroy/reset コマンドはない。kintone provider は削除を拒否する。state を捨てることや新 generation はリセットではない。破壊的 cleanup、権限修復、所有権移管の扱いは今後の設計対象である。

## 検証

`bun test scripts/tests/terraform-runner.test.ts` は外部サービスなしで bundle 制限、隔離、環境変数、承認、失敗時 state 保持、改ざん、並行操作を確認します。`scripts/tests/fixtures/terraform-builtin` は Terraform 実バイナリで init/validate/plan/apply を試せる fixture です。

参考: [saved plan](https://developer.hashicorp.com/terraform/cli/commands/plan)、[dependency lock file](https://developer.hashicorp.com/terraform/language/files/dependency-lock)、[CLI configuration](https://developer.hashicorp.com/terraform/cli/config/config-file)。saved plan は機密を平文で含むことがあるため private 保持が必要です。

# 現行 Local UI の連続操作実演

[動画を開く](./tenkacloud-local-ui-continuous.mp4)

約 46 秒、1280 × 840、H.264。静止画 4 枚のレビュー版とは別の、専用 headless browser で収録した連続操作映像です。主催者の問題選択・大会作成・開始、参加者の URL とチームキーによるサインイン・解答提出・得点確認、主催者の終了・撤収・Removed 確認を順に示します。待ち時間を編集し、日本語の手順見出しを焼き込んでいます。音声はありません。

新しい一時 SQLite、合成チーム、test-only exercise adapter を使います。認証キーと解答は収録時に塗りつぶします。実ユーザーデータ、既存の開催環境、Mac の現画面は使いません。全編の注記にあるとおり、実 AWS・Docker への配置の成功証拠ではありません。既存 Cloud 動画と YouTube リンクは置換せず保持します。

## 再生成

既にインストール済みの Bun、Python、ffmpeg/ffprobe、Chromium と repo の依存関係を使います。ブラウザのダウンロードや AWS 操作は行いません。

```sh
python3 scripts/landing/onboarding-videos/record-local-ui.py --output .cache/local-ui-video/raw
bun run scripts/landing/onboarding-videos/render-local-ui.ts .cache/local-ui-video/raw docs/assets/local-ui/tenkacloud-local-ui-continuous.mp4
ffmpeg -hide_banner -loglevel error -i docs/assets/local-ui/tenkacloud-local-ui-continuous.mp4 -f null -
```

macOS では既存 Google Chrome を使います。別の Chromium は`HOST_E2E_CHROMIUM`で指定します。収録は既存 Local browser rehearsal を隔離 driver として再利用し、古い詳細ページの見出し待ちを収録 driver 内で除きます。元のアプリ・テストを変更しません。出力先に raw 録画と役割 metadata、検証済み画面を保存します。raw はレビュー前に公開しないでください。

役割 metadata で主催者と team-1 の映像を選び、冒頭 18 秒、参加者の操作、主催者の末尾 7 秒を編集します。UI や操作時間が変わったときは、この切り出し位置を映像で再確認してください。

収録時点の主催者モーダルには「Copy invite」が残っています。この動画はその機能を使わず、参加者 URL とチームキーでサインインします。これは現行ソースの表示であり、文書だけで UI の削除完了を示すものではありません。

## 検証

- 隔離 browser rehearsal：大会作成、2 チームの独立した解答提出・各 100 点、終了・撤収を検証して成功。
- 映像：認証キーと解答のマスク、解答提出、team-1 の 100 点、Removed を画面で確認。
- ffmpeg による全デコード、編集スクリプトの lint と scripts/host 型検査に成功。

Cloud UI の実演と実 AWS の操作録画は、この動画の対象に含みません。

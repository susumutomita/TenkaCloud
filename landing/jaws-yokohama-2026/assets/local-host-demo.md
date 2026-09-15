# ローカル開催の操作動画

- 録画日: 2026-09-15
- 実装: [PR #3234](https://github.com/susumutomita/TenkaCloud/pull/3234)、commit `f1b2faafb136facd7e4b311b2e8f5b3748d99241`。録画時点で開発中。
- 問題: TenkaCloudChallenge `6f8a53f850a9cd5f8c0e34e69a3b5ca311d09cf8` の `sqli-demo`。
- 実行: Bun、SQLite、Docker。既存の `vite.host.config.ts` で両 UI をビルドし、`bun start --data /private/tmp/jaws-host-state --admin-port 5274 --participant-port 5275` で起動。
- 確認: 管理画面でイベント・2 チームを作成し、実 Docker 環境 2 件を準備。競技開始、チームキーによる参加者ログイン、問題一覧、実コンテナの問題画面を確認。
- 境界: AWS への配置、AWS フェデレーション、クラウド Turso、暗号バトルの開催を検証した動画ではない。SQL 問題の正解提出・得点更新はこの動画の対象外。
- 編集: 実操作録画から待ち時間、主催者・参加者キーの入力と配布画面を除外。問題画面のみ同じ実環境で追撮。画面の状態や成功表示は作成・差し替えしていない。
- 形式: H.264 MP4、1440 × 900、約 41 秒、音声なし、日本語 WebVTT 字幕。MP4 を LP と同じ配信経路へ直接配置。
- 再現時の注意: Bun 1.3.11 では既存 build ラッパーがヘルプのみを出力したため、各アプリの既存 Vite 設定で直接ビルドした。問題リンクは 60 秒で失効し、参加者画面で更新してから開く。
- 公開前確認: 41 枚の毎秒フレームを OCR で検査し、発行済みキー・ticket URL が含まれないことを確認。編集点を含む画面の目視確認も実施。録画に使った問題コンテナ 2 件は撤収済み。

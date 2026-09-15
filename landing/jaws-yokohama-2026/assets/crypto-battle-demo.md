# 暗号バトル録画の出典

2026-09-15 に、`problems` のコミット
`6f8a53f850a9cd5f8c0e34e69a3b5ca311d09cf8` にある
`battles/ac26-crypto-battle/dev` で録画しました。
別プロジェクトの動画や、得点を直接書き換えた成功画面は使用していません。

## 再現

```sh
cd problems/battles/ac26-crypto-battle/dev
bun install --frozen-lockfile
bun run dev
```

`http://localhost:5644` で `fresh`、`alpha`、日本語を選び、時計を停止した状態から操作しました。

1. Sudoku のお題を開き、画面の置換表を使って空欄を回答する。正解で alpha に 30 点。
2. 開発用時計を 1 分進め、alpha の次のお題から LEAK する。10 点を得て合計 40 点。
3. 同じ対戦の bravo 席へ切り替え、HUNT を開く。
4. 公開された `a = [4, 1, 3]` と `b = [2, 5, 1]` から `5 − 1 = 4 (mod 6)` を計算して回答する。
5. HUNT 成立で bravo に 8 点、alpha は 12 点減って 28 点となる。

実ゲームの reducer と参加者 UI を使用する既存ローカル実行環境です。
開発用の席切り替え、インメモリ状態、時計操作を含み、AWS 上の認証・永続化・公式得点の検証ではありません。
詳しい境界は同ディレクトリの README を参照してください。

## 配信ファイル

- `crypto-battle-demo.mp4`: 同一対戦の連続操作、73.7 秒、1140×900、H.264、音声なし、約 1.35 MB。左右の黒い余白を除き、CRF 23 で圧縮し、faststart を設定。メタデータを除去した。
- `crypto-battle-demo.png`: 同じ録画の 60 秒地点の静止画。動画ポスターと印刷に使用。
- `crypto-battle-demo.ja.vtt`: 操作と得点の日本語字幕 6 件。

公開用フレームを確認し、参加キー・認証情報・個人情報が映っていないことを確認しました。
表示される alpha / bravo と暗号のお題の値はローカルゲーム内のデータです。

# 1 分でわかる TenkaCloud (紹介動画)

[動画を開く](../../../landing/videos/lp/tenkacloud-60s.mp4)

64 秒、1920 × 1080、30 fps、H.264 + AAC。音楽と効果音があり、ナレーションはありません。見出しは日本語で、英語の字幕を添えています。LP のヒーロー、両 README、BootCamp #4 発表資料の Appendix から参照します。

SHA-256: `7034983ea908d6965a29d948222ad8f692ff9842acf82afa2c91dcdeb14eacbd`

## 画面の出どころ

ウィンドウ内の画面は、2026-11-10 (UTC) に 1 台のマシンで起動した実物を撮影したものです。動画側の加工は、切り出し、ズーム、金色の枠による強調だけです。

- TenkaCloud `f5783ac` を `make local` で起動。問題カタログは TenkaCloudChallenge `a7a9cfe`。
- TenkaCloudSimulator `36e72c4` をソースから `make build` し、`--simulator-endpoint` と `--simulator-bootstrap` で接続。「クラウド連携」に登録して Verify 済み。
- 大会 Tenka Battle Cup 2026 (Hello World、3 チーム) を作成し、Simulator へ配置して開始。1 チームはヒントを 1 つ開いて 80 pt、もう 1 チームはヒントなしで 100 pt。
- 大会 Tenka Open 2026 (暗号バトルと Hello World)。3 チームが準備完了を押し、試合が始まった状態を撮影。
- Simulator の Google Cloud Storage バケット、Azure Blob コンテナー、さくらのディスク構成は、Simulator 自身のコンソールから作成。

主催者キー、チームキー、Simulator のトークン、解答 (flag) は画面上で伏せ字にしています。

## 実画面ではないもの

- 22〜30 秒のターミナル：`make local` の実際の出力行を抜粋し、文字として組んだもの。主催者キーの行は含めない。
- 48〜52 秒のカードの並び：カタログにある問題の ID と名前を並べたもの。「＋ あなたの問題」のカードは説明用。
- 背景の城・雷雲・金の筆致：書籍『自分で作るクラウド競技』の表紙絵を 4 倍に拡大したもの。拡大には Real-ESRGAN を使っており、細部には元絵と一致しない箇所がある。
- 音楽と効果音：この動画のために合成したもの。既存の楽曲や音源は不使用。

## この動画が示していないこと

- Docker 問題は含まない。収録環境に Docker がなかったため。
- 実 AWS への配置は含まない。Simulator で動かしたのは Hello World の 1 問で、Simulator 連携の検証対象もこの 1 問。
- Google Cloud、Azure、さくらの場面は Simulator のコンソール操作。対応範囲はそれぞれ Cloud Storage、Blob Storage、ディスク構成で、これらのクラウド向けの問題を大会で解く場面は含まない。
- Simulator は独立したシミュレーターで、各クラウドの公式のものではない。

## 検証

- ffmpeg で全フレームをデコードし、エラーがないことを確認。
- 全シーンの連番シートと、キー・解答の伏せ字部分の等倍切り出しを目視で確認。
- 統合ラウドネスは −15.0 LUFS。音の聴感は収録者が未確認のため、公開前に試聴が必要。

## ファイル

- `landing/videos/lp/tenkacloud-60s.mp4`: 公開用の動画。
- `tenkacloud-60s-preview.gif`: README 用のプレビュー (640 × 360、13 コマ)。
- `tenkacloud-60s-poster.jpg`: 8.6 秒時点の静止画 (1280 × 720)。

動画の生成に使ったスクリプトと撮影素材は、このリポジトリには含めていません。

# Codex App goal prompt

```text
codex goal

TenkaCloud pitch deck の [index.html](landing/pitch/index.html) を、`landing/pitch/assets/references/slide-01`〜`slide-09` の参照画像に近づける形で全面リデザインしてください。

必ず [DESIGN_REPRODUCTION_GOAL.md](landing/pitch/docs/DESIGN_REPRODUCTION_GOAL.md) を読み、その指示に従ってください。

重要な方針:
- 参照画像は「完成イメージ」です。画像をそのまま貼るのではなく、HTML/CSS/JSで再現してください。
- 背景・筆文字・金色装飾・エンブレムなど、HTMLで再現しづらいものは画像素材化して構いません。
  - 画像素材化する場合 `image_gen` ツールを使用し `magick`などでwebpなどの画像ファイルに変換すること
  - `image_gen` ツールを使わず `magick` などで直接画像を作成すると品質が著しく低下するため、 `magick` などの画像処理ツールは、 `image_gen` で作成した画像の変換や修正（背景を透明にするなど）飲みに使用してください
- 見出し、本文、カード、スコアボード、アニメーションはHTML/CSS/JSで保持してください。
- slide 04 の既存アニメーション（deploy→inject→score→rank、スコア更新、順位更新、インシデント表示、カウントダウン）は必ず維持し、新デザインに載せ替えてください。
- 実装後は必ずブラウザで表示確認してください。
- 参照画像との再現性チェックと、スライドデザインとしての品質チェックを両方実施してください。
- 文字が枠からはみ出す、下部が切れる、余白が不自然に多い、見出しが弱い、コントラストが低い、slide 04 のアニメーションが壊れる、といった状態では完成扱いしないでください。
- ブラウザ確認で問題が見つかった場合は、再現性とデザイン品質の両方が満たされるまでCSS/HTML/JSを修正してください。

作業ステップ:
1. 現行 [index.html](landing/pitch/index.html) の構造と既存JSを把握する。
2. CSS/JSを必要に応じて `landing/pitch/styles/pitch-theme.css` と `landing/pitch/scripts/pitch.js` に整理する。
3. 共通デザインシステム（dark navy / electric blue / gold、背景、カード、下部コールアウト、スライド番号）を作る。
4. まず slide 01 を参照画像に近づけて完成度高く再現する。
5. slide 02〜03 を再現する。
6. slide 04 をアニメーション維持のまま新デザインにする。
7. slide 05〜09 を再現する。
8. ブラウザで9枚すべて確認し、参照画像との再現性とスライド品質をチェックする。
9. 問題があれば修正し、再確認する。

完了時には、以下を報告してください:
- 変更したファイル一覧
- 参照画像に対して特に近づけた点
- slide 04 のアニメーション維持確認
- ブラウザで確認した内容
- 残っている差分や妥協点があれば正直に列挙
```

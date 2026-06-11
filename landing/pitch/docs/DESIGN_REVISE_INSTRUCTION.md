# TenkaCloud ピッチデッキ 参照画像再現 修正指示書

## 目的

`landing/pitch/index.html` を、参照画像 `landing/pitch/assets/references/slide-01〜09` のデザインに近づける。設計ドキュメントは `landing/pitch/docs/DESIGN_REPRODUCTION_GOAL.md` にあり、本指示はその具体化。現状の HTML は情報設計・配置はほぼ参照どおりで、差分は「背景の明るさ」「筆文字・見出しのスケール」「アイコンの密度」「色のセマンティクス」の4系統＋レイアウトバグ1件。

## 必須の作業ルール

- 実装後は**必ずブラウザで実機確認**する（`python3 -m http.server 8000` → `http://localhost:8000/landing/pitch/`）。1280×720 ビューポートで9枚すべてスクリーンショットを撮り、対応する参照画像と比較すること
- slide 04 の既存 JS アニメーション（`scripts/pitch.js`: ステップの active 切替・スコア更新・順位並べ替え・インシデント表示・カウントダウン）は**絶対に壊さない**
- 文字（見出し・本文・カードタイトル・スコアボード・CTA）は HTML のまま保持。画像化してよいのは筆文字・金装飾・エンブレム・イラストのみ
- 透過素材は `image_gen` の透明背景を信用せず、**緑背景 `#00ff00` で生成 → Python でクロマキー透過 → 軽くフェザー → PNG 保存**の2段工程（`landing/pitch/scripts/remove_bg.py` として保存）
- **商標ロゴ（AWS / GitHub octocat / LinkedIn）は `image_gen` で生成しない**。公式ブランド素材の SVG を使うか現行表現を維持
- `rm` 禁止（`git rm` を使う）、`npx` 禁止（`bunx`）。PR には `## Regression analysis` と `## Physical impact` セクションを含める

---

## 0. 全スライド共通の修正

### 0-1. 背景が暗すぎる

参照では城・「天下一」垂れ幕・観客・青い照明がはっきり見えるが、HTML は `styles/pitch-theme.css` の `.slide-shell` の `linear-gradient(90deg, rgba(2,8,20,.98) ...)` と `.slide-shell::before` の下部 `rgba(2,8,20,.82)` が背景をほぼ潰している。

- [ ] まずオーバーレイの不透明度を下げて確認（左端 `.98 → .88` 程度、下部 `.82 → .6` 程度から調整）
- [ ] それで足りなければ、観客＋サイリウム＋紙吹雪入りの明るいアリーナ背景3種（right / wide / center）を `image_gen` で再生成して `assets/bg/` を差し替え。プロンプトには `No text, no logos, no labels, except the vertical banner may contain 「天下一」` を必ず含める

### 0-2. コールアウト両端の金の飛沫

- [ ] 現在の CSS グラデーション縞（`.tc-callout::before/::after`）を、`image_gen` で生成した透過の金筆ストローク PNG（左右ペア、`assets/ornaments/` に配置）へ差し替える。全9枚の品質が一度に上がるので優先度高

### 0-3. 番号サークルの青/金バリアント

- [ ] `.number-dot` に**金サークル（濃紺数字）の `--gold` バリアントを新設**し、slide 03 / 04 / 08 に適用。slide 01 / 02 / 06 は青のまま

### 0-4. デッドCSSの掃除

- [ ] `<img>` 要素への `::before/::after`（`.line-icon.cloud::before`, `.fix-visual.lock::before`, `.trophy-icon::before/::after`, `.cloud-logo::before/::after`, `.samurai-avatar::before`, `.portrait::before`, `.handshake-icon::before/::after`, `.emblem::before` 等）は置換要素なのでレンダリングされない画像化前の残骸（約120行）。削除する

---

## 1. Slide 01 — Hero（参照: `slide-01-tenkacloud-hero.png`）

- [ ] `天下一武道会` 筆文字: `.brush-hero` を 590px → **約660px** に拡大。`クラウドエンジニアの`（`.hero-lead-ja`）も 47px → 約54px
- [ ] `HOW A MATCH RUNS` 見出し: 参照は**白文字＋濃紺バンドの帯ラベル**。現在は青テキストのみなのでバンド背景を追加
- [ ] 3枚の run-card の間に**発光する青い ▶ 矢印**を追加（slide 04 の `.bl-arr` を流用すれば CSS だけで可能）
- [ ] 右上の `aws` マークと左下サポートパネルの「AWS」: CSS 文字の自作ロゴは参照の本物と乖離。公式 SVG を使うか、現行を維持するかはユーザー判断事項として PR に明記（`image_gen` での生成は禁止）

## 2. Slide 02 — StackStack problem（参照: `slide-02-stackstack-problem.png`）

- [ ] 見出し `AI が作った 1 つのアプリ。`: 48px → **約60px**
- [ ] 筆文字 `でも、公開できない。`: `.brush-problem` 570px → **約760px**（参照は画面幅の6割）
- [ ] **5枚の fix カードを二連アイコン構成に組み替え**（このスライド最大の差分）。参照は「白銀の before アイコン → 青矢印 → 金の after アイコン」＋下段に「before ラベル（白・小）/ after ラベル（金・太字・大）」の2段。`image_gen` で以下10アイコンを生成（緑背景→透過、`Single centered icon, no text, no shadow, solid #00ff00 background for chroma key`）:
  - before（白銀）: 南京錠 / 公開S3バケット＋地球儀 / 白ゲージ / ターミナルプロンプト / EC2サーバ1台
  - after（金）: シールド内人物(SSO) / シールド付きクラウド(OAC) / 金ゲージ(throttle) / 錠付きドキュメント(WORM) / 多段サーバスタック(Multi-AZ)
  - HTML 側は `.fix-card` を「icon + 矢印 + icon」grid に組み替え、`Basic認証`（白）→ `SSO`（金太字）の2段ラベルに
- [ ] カードタイトル `auth` / `network` 等: 青 → **白**（参照は白）
- [ ] problem カード: `90` と `90 分` は**金**（現在は `h3 strong` / `p b` が一律青。`90` 系だけ金に分離）
- [ ] 番号サークルは参照も青なので現状維持（変更しないことの確認）

## 3. Slide 03 — Game design（参照: `slide-03-game-design.png`）

- [ ] **4カード上部のイラストを `image_gen` で生成**（現状との乖離が最大）。カード内イラスト4枚（約1240×660px、**文字なし指定**）を `.quest-art` の背景に敷く:
  1. AWS風のクラウドがステージ上にホログラム投影される起動シーン
  2. 光る亀裂の入った城壁＋その上に盾アイコン3枚
  3. 夜の戦闘シーン（インシデントタグ用の余白を上部に残す）
  4. 金トロフィー＋勝利を喜ぶ群衆のシルエット＋旗
  - インシデントタグ（DB誤削除等）は HTML のまま画像に重ねる（文言修正可能性の維持）
- [ ] カード間に**青い ▶ 矢印**を追加（`.quest-grid` を `1fr 22px 1fr ...` に変更して挿入）
- [ ] 番号サークル: 青 → **金**
- [ ] 筆文字 `襲ってくる事故を捌く。`: `.brush-incidents` 665px → **約840px**
- [ ] インシデントタグの枠色: オレンジ → 参照の**金/青枠**チップに
- [ ] コールアウトの `サイトを稼働させ続けた`: `.brush-inline` 1.12em → **約1.35em** の金グラデで強調

## 4. Slide 04 — Battle mechanism（参照: `slide-04-battle-mechanism.png`）※アニメーション維持必須

- [ ] 番号サークル: 青 → **金**（4つとも）
- [ ] samurai アバター: 参照は正面向きの**装飾的な金の兜（kabuto）エンブレム**。`image_gen` で再生成して差し替え
- [ ] `残り 00:11:51` の前に**青い時計アイコン**を追加（小さい inline SVG で十分）
- [ ] スコアタイル: `Score` ラベルを上辺のタブ状に、`8,420` を 50px → **約58px** に拡大
- [ ] 順位表の自分の行（`.rank-row.mine`）: 青背景のみ → **青く発光するボーダー枠**で行全体を囲む（`box-shadow`/`outline` 追加。`flash` アニメと共存させる）
- [ ] 4ステップカードの英単語（`deploy` 等）: 38px → 約42px
- [ ] 変更後、ブラウザで**アニメーションが全部動いていること**（active切替・スコア更新・並べ替え・インシデント・時計）を必ず目視確認

## 5. Slide 05 — Platformization（参照: `slide-05-platformization.png`）⚠️ 実測バグあり

- [ ] **【最優先バグ】`.platform-sub` が `.battle-cards` と 22px 重なっているのを解消**（1280×720 実測: sub の bottom=438px、cards の top=416px。絶対配置同士の衝突でテキスト末尾がカードの裏に隠れる）
- [ ] 筆文字 `プラットフォーム。`: `.brush-platform` 630px → **約900px**（参照はほぼ全幅）。TenkaCloud タイトルと `天下一武道会を開くための` の行間を詰めれば、拡大と重なり解消は両立できる（参照の縦リズム: タイトル → 小見出し → 特大筆文字 → サブ2行 → カード）
- [ ] `BATTLE` ラベル: 青テキストのみ → **青グラデのリボン帯に白文字**
- [ ] エンブレム: **細い金枠の正方形フレーム**で囲む（CSS で枠追加。webp は流用可）
- [ ] サブ文の色分け: `StackStack` は青のまま、`OSS` は**金**に（現在 `platform-sub strong` が一律青）

## 6. Slide 06 — Use cases（参照: `slide-06-use-cases.png`）

- [ ] 番号: 六角形（`.hex-no` の clip-path）→ **青い円**
- [ ] 英字ラベル `COMMUNITY` / `EDUCATION` / `ASSESSMENT`: 青 → **白**（letterspaced）
- [ ] 和文タイトル（`コミュニティイベント` 等）: 金文字のみ → **金文字＋金枠のボックス帯**で囲む
- [ ] アイコン: `.use-card .line-icon` 114×96 → **約140px** に拡大（既存 webp 拡大で許容範囲なら再生成不要。寄せるなら「旗を持つ人々/開いた本＋盾/クリップボード＋棒グラフ」の blue line-art を `image_gen`）
- [ ] 筆文字 `研修にも、採用にも。`: 720px → **約800px**

## 7. Slide 07 — Team（参照: `slide-07-team.png`）

- [ ] ポートレート: **金の二重リング円形フレーム**を追加（CSS リングで可。より寄せるなら `image_gen` で「金の円形メダリオン＋人物シルエット」3種を再生成）
- [ ] リンクチップ（Portfolio / LinkedIn / GitHub）: 金枠・金文字 → **青枠＋白文字＋各サービスアイコン付き**。GitHub マークは公式 SVG（`image_gen` 禁止）
- [ ] 名前と実績の間に**水平の区切り線**を追加（参照にあり）
- [ ] コールアウトの `熱量ある問題を作れる人` をもう一段大きく金で
- [ ] 構成・カード幅比（FOUNDER 幅広）は参照と一致しているので変えない（変更しないことの確認）

## 8. Slide 08 — Looking for（参照: `slide-08-looking-for.png`）

- [ ] **カード内の色を参照に合わせて入れ替え**: ラベル（`共同開発` 等）＝**金**、タイトル（`競技が好きな仲間` 等）＝**白・大**（現在 `h3` 青 / `h4` 金で逆）
- [ ] 番号サークル: 青 → **金**
- [ ] カード3の `ライセンス:` / `課金:` を**金の強調**に
- [ ] 見出し: 54px → 約61px、`壁打ち相手` 筆文字 430px → 約460px
- [ ] コールアウトの `声をかけてください。` を本文の **約1.5倍の特大金文字**に（参照では圧倒的に大きい）
- [ ] handshake アイコンをもう一回り拡大

## 9. Slide 09 — Thank you（参照: `slide-09-thank-you.png`）最も完成度が高い

- [ ] CTA タイトル `Repository` / `問題 (Problems)` / `Landing`: 金 → **青**
- [ ] CTA アイコン: 裸の青アイコン → **青い塗りつぶし円バッジの中に白アイコン**（GitHub は octocat 公式 SVG）
- [ ] `bg-center` のオーバーレイを弱め、中央の城と観客のサイリウムを見せる
- [ ] CTA カード高 184px → 約150px に詰めて締める

---

## image_gen 素材リスト（優先順）

| 優先 | 素材 | 用途 | 仕様 |
|---|---|---|---|
| 1 | カード内イラスト4枚（ホログラム起動 / 亀裂の城壁 / 夜間戦闘 / 勝利の群衆＋トロフィー） | Slide 03 | 約1240×660px、文字なし、dark navy + electric blue + gold のトーン |
| 2 | before アイコン5種（白銀）＋ after アイコン5種（金） | Slide 02 | 緑背景 `#00ff00` → クロマキー透過 |
| 3 | 金筆ストローク装飾 PNG 左右ペア | 全コールアウト | 透過、有機的な筆致 |
| 4 | 明るいアリーナ背景3種（right / wide / center） | 全スライド | CSS 減光で足りなければ。`天下一` 垂れ幕以外の文字禁止 |
| 5 | 金の兜（kabuto）エンブレム | Slide 04 | 透過 |
| 6 | 金円形メダリオンのポートレート3種 | Slide 07 | CSS リング枠で代替可ならスキップ |
| 7 | 大型 blue line-art アイコン3種 | Slide 06 | 既存 webp 拡大で許容なら不要 |

## 完了条件（検収）

- [ ] 1280×720 で9枚すべてをブラウザ実機確認し、参照画像と並べて比較した
- [ ] Slide 05 の重なりが解消され、全スライドでテキストのはみ出し・要素の重なりがゼロ
- [ ] Slide 04 のアニメーションが全部動いている
- [ ] 筆文字・見出しが参照と同等のスケール感になっている
- [ ] GitHub Pages で動く相対パスのまま
- [ ] `make before-commit` が通る

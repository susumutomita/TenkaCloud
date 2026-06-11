# TenkaCloud Pitch デザイン再現実装指示書

## 目的

現在の `landing/pitch/index.html` を、参照画像 `landing/pitch/assets/references/slide-01`〜`slide-09` のデザインに近づける。

単に雰囲気を寄せるのではなく、**参照画像のスライドデザインとしての完成度・密度・視線誘導・配色・余白・カード配置を再現する** ことを目的とする。

ただし、参照画像をそのまま背景として貼るのではなく、以下のハイブリッド方針で実装する。

- 背景・筆文字・金色装飾・エンブレムなど、HTML/CSSで再現しにくい要素は画像素材として扱う
- 見出し・本文・カード・スコアボード・アニメーションなど、修正可能性が重要な要素はHTML/CSS/JSで実装する
- slide 04 の既存アニメーションは維持し、新デザインに載せ替える
- 実装後は必ずブラウザで表示確認し、参照画像との再現性とスライドデザイン品質の両方を満たすまで修正する

---

## 保存済み参照画像

以下を「完成イメージ画像」として扱う。

```text
landing/pitch/assets/references/
├─ slide-01-tenkacloud-hero.png
├─ slide-02-stackstack-problem.png
├─ slide-03-game-design.png
├─ slide-04-battle-mechanism.png
├─ slide-05-platformization.png
├─ slide-06-use-cases.png
├─ slide-07-team.png
├─ slide-08-looking-for.png
└─ slide-09-thank-you.png
```

これらは直接スライド背景として全面貼り付けるための素材ではなく、**再現対象のデザイン仕様** として使う。

---

## 推奨ディレクトリ構成

既存の `landing/pitch/index.html` を起点に、以下の構成へ整理する。

```text
landing/pitch/
├─ index.html
├─ docs/
│  └─ DESIGN_REPRODUCTION_GOAL.md
├─ styles/
│  └─ pitch-theme.css
├─ scripts/
│  └─ pitch.js
└─ assets/
   ├─ references/
   │  ├─ slide-01-tenkacloud-hero.png
   │  ├─ slide-02-stackstack-problem.png
   │  ├─ slide-03-game-design.png
   │  ├─ slide-04-battle-mechanism.png
   │  ├─ slide-05-platformization.png
   │  ├─ slide-06-use-cases.png
   │  ├─ slide-07-team.png
   │  ├─ slide-08-looking-for.png
   │  └─ slide-09-thank-you.png
   ├─ bg/
   │  ├─ tenka-arena-right.webp
   │  ├─ tenka-arena-wide.webp
   │  └─ tenka-arena-center.webp
   ├─ brush/
   │  ├─ tenkaichi-budokai.png
   │  ├─ slide-02-cannot-publish.png
   │  ├─ slide-03-handle-incidents.png
   │  ├─ slide-05-platform.png
   │  ├─ slide-06-training-hiring.png
   │  ├─ slide-07-passion.png
   │  ├─ slide-08-partners.png
   │  └─ slide-09-thank-you-jp.png
   ├─ ornaments/
   │  ├─ trophy-gold.png
   │  ├─ gold-brush-corner-left.png
   │  ├─ gold-brush-corner-right.png
   │  ├─ gold-divider.png
   │  └─ gold-underline-long.png
   ├─ icons/
   │  ├─ cloud-upload.svg
   │  ├─ shield-check.svg
   │  ├─ chart.svg
   │  ├─ lock.svg
   │  ├─ terminal.svg
   │  ├─ users.svg
   │  ├─ book-shield.svg
   │  └─ clipboard-chart.svg
   ├─ emblems/
   │  ├─ battle-stackstack.png
   │  ├─ battle-security.png
   │  └─ battle-migration.png
   └─ avatars/
      ├─ amedama.png
      ├─ charlie.png
      └─ kisenon.png
```

最初から全素材を用意しきる必要はない。まずは `references` とCSS/HTMLだけで近づけ、必要に応じて `bg` / `brush` / `ornaments` / `emblems` を追加する。

---

## 実装方針

### 1. 参照画像を“答え”として扱う

各スライドのHTML実装は、対応する参照画像を目標とする。

| スライド | 参照画像 |
|---|---|
| 01 | `slide-01-tenkacloud-hero.png` |
| 02 | `slide-02-stackstack-problem.png` |
| 03 | `slide-03-game-design.png` |
| 04 | `slide-04-battle-mechanism.png` |
| 05 | `slide-05-platformization.png` |
| 06 | `slide-06-use-cases.png` |
| 07 | `slide-07-team.png` |
| 08 | `slide-08-looking-for.png` |
| 09 | `slide-09-thank-you.png` |

### 2. 共通背景を用意してブレを抑える

参照画像では、右上の夜の城・「天下一」垂れ幕背景がスライドごとに微妙に異なる。HTML版では共通背景素材として統一する。

推奨:

- `assets/bg/tenka-arena-right.webp`
  - slide 02〜08向け。右上に城、左側に本文。
- `assets/bg/tenka-arena-wide.webp`
  - slide 01向け。背景を広く使う。
- `assets/bg/tenka-arena-center.webp`
  - slide 09向け。中央に城。

背景は `body` ではなく各 `.canvas` または `.slide-shell` に適用する。

```css
.slide-shell {
  position: relative;
  overflow: hidden;
  background:
    linear-gradient(90deg, rgba(2,8,20,.98) 0%, rgba(2,8,20,.84) 42%, rgba(2,8,20,.45) 100%),
    url("../assets/bg/tenka-arena-right.webp") center / cover no-repeat;
}
```

### 3. 文字は原則HTMLで持つ

以下は画像化しない。

- ページ番号
- セクションタイトル
- 通常の大見出し
- 本文
- カードタイトル
- カード本文
- スコアボード
- チーム名
- CTA文

理由:

- 文言修正しやすい
- 差分管理しやすい
- レスポンシブ調整しやすい
- slide 04 のアニメーションを維持できる

### 4. 筆文字・金色装飾は画像化してよい

以下は画像素材化してよい。

- `天下一武道会`
- `でも、公開できない。`
- `襲ってくる事故を捌く。`
- `プラットフォーム。`
- `研修にも、採用にも。`
- `大好き`
- `仲間`
- `壁打ち相手`
- `ありがとうございました。`
- 金色の筆しぶき
- 金色トロフィー
- バトルエンブレム
- チームアバター

ただし、画像を使う場合もHTML上に意味が残るように `alt` または隠しテキストを入れる。

```html
<h1 class="hero-title">
  <span>クラウドエンジニアの</span>
  <img class="brush-title" src="assets/brush/tenkaichi-budokai.png" alt="天下一武道会">
</h1>
```

---

## 共通デザインシステム

### 配色

```css
:root {
  --tc-bg: #020814;
  --tc-bg-2: #06162d;
  --tc-panel: rgba(3, 13, 31, .82);
  --tc-panel-strong: rgba(2, 8, 20, .92);
  --tc-blue: #2688ff;
  --tc-blue-2: #58b7ff;
  --tc-gold: #d6a847;
  --tc-gold-2: #f1cd72;
  --tc-white: #f7fbff;
  --tc-muted: #b8c7dc;
  --tc-danger: #ff7a3c;
}
```

### 共通カード

```css
.tc-panel {
  background: linear-gradient(180deg, rgba(4,18,38,.88), rgba(2,8,20,.94));
  border: 1px solid rgba(59, 156, 255, .75);
  box-shadow:
    0 0 0 1px rgba(20, 120, 255, .16) inset,
    0 0 24px rgba(0, 132, 255, .22);
  border-radius: 14px;
}
```

### 斜め角カード

```css
.tc-panel-cut {
  clip-path: polygon(
    14px 0, 100% 0,
    100% calc(100% - 14px),
    calc(100% - 14px) 100%,
    0 100%, 0 14px
  );
}
```

### 下部コールアウト

```css
.tc-callout {
  position: relative;
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 86px;
  padding: 18px 28px;
  border: 1px solid rgba(214,168,71,.8);
  background: linear-gradient(90deg, rgba(4,14,31,.92), rgba(2,8,20,.86));
  box-shadow: 0 0 24px rgba(214,168,71,.16);
}
```

---

## スライド別の再現方針

### slide 01

参照: `slide-01-tenkacloud-hero.png`

目的: TenkaCloudの世界観を最も強く見せる。

構成:

- 左上: `01 TenkaCloud とは`
- 左: `TenkaCloud` 大タイトル
- 左: `OSS・本物のクラウドで開く競技プラットフォーム`
- 左中央: `クラウドエンジニアの` + 筆文字 `天下一武道会`
- 左下: AWS / 対応予定クラウド
- 右: `HOW A MATCH RUNS` 3ステップカード
- 下: StackStack導入コールアウト

### slide 02

参照: `slide-02-stackstack-problem.png`

目的: StackStackの問題設定を強く見せる。

構成:

- 左: `AI が作った 1 つのアプリ。ローカルでは動く。`
- 金筆文字: `でも、公開できない。`
- 右: `problem: StackStack / 90 min`
- 中央下: 5つの改善カード
  - auth
  - network
  - rate
  - audit
  - uptime
- 下: `"動く" から "出していい" までの距離`

### slide 03

参照: `slide-03-game-design.png`

目的: ゲームデザインの流れを視覚化する。

構成:

- 大見出し: `クラウドに上げて、穴を塞ぎ、襲ってくる事故を捌く。`
- 4ステップカード
  - クラウドで起動
  - 穴を塞ぐ
  - インシデント対応
  - サイトを稼働させ続けると得点を獲得
- 下: 勝利条件

### slide 04

参照: `slide-04-battle-mechanism.png`

目的: 競技の進み方とライブ感を表現する。

重要: 既存JSのアニメーションを維持する。

維持する挙動:

- deploy → inject → score → rank の active 切替
- スコア更新
- 順位表の並べ替え
- インシデント発生/復旧表示
- カウントダウン

新デザインで追加/調整すること:

- 上部4ステップをネオンカード化
- スコア表示を中央で大きく見せる
- チームステータスを左、順位表を右に配置
- 更新時に該当行が光る
- インシデント発生時はオレンジ/赤、復旧時は青/緑で表示

### slide 05

参照: `slide-05-platformization.png`

目的: StackStackが第一試合であり、TenkaCloudは競技プラットフォームであることを示す。

構成:

- 大見出し: `TenkaCloud`
- 筆文字: `プラットフォーム。`
- 説明: StackStackは第一試合、問題はOSSで増やせる
- 3つのBATTLEカード
  - StackStack
  - Security Battle Royale
  - Microservice Migration
- 下: AWS対応 / OSS

### slide 06

参照: `slide-06-use-cases.png`

目的: 用途の広がりを示す。

構成:

- 大見出し: `祭りだけじゃない。研修にも、採用にも。`
- 3カラム
  - COMMUNITY
  - EDUCATION
  - ASSESSMENT
- 下: `同じ仕組みが、イベント・研修・採用評価まで回す。`

### slide 07

参照: `slide-07-team.png`

目的: 熱量あるチームであることを示す。

構成:

- 大見出し: `クラウド競技が大好きなメンバーが作っています。`
- 3プロフィールカード
  - amedama
  - チャーリー
  - きせのん
- 下: `熱量ある問題を作れる人`

### slide 08

参照: `slide-08-looking-for.png`

目的: 一緒に作る仲間と壁打ち相手を募集する。

構成:

- 大見出し: `一緒に作る仲間と、壁打ち相手を探しています。`
- 説明: クレイジーキルト
- 3カード
  - 共同開発
  - クラウド推進
  - 壁打ち
- 下: `ピンと来たら、ぜひ声をかけてください。`

### slide 09

参照: `slide-09-thank-you.png`

目的: 印象的に締める。

構成:

- 大きな筆文字または通常文字: `ありがとうございました。` または `Thank you.`
- 説明: `触ってみてください。問題も、コードも、すべて OSS。`
- 3 CTAカード
  - Repository
  - 問題 (Problems)
  - Landing
- 必要ならQRコードを残す

---

## 画像素材生成・加工方針

### 透明背景が必要な場合

`image_gen` の透明背景は、透明チェッカー柄を画像内に描いてしまうことがあるため信用しすぎない。

推奨手順:

1. 背景色を単色のグリーン `#00ff00` または白 `#ffffff` で生成
2. Pythonで背景色をアルファ化する
3. 境界を少しフェザーする
4. PNGとして保存

推奨スクリプト名:

```text
landing/pitch/scripts/remove_bg.py
```

### 画像生成プロンプトの注意

背景素材:

```text
No text, no logos, no labels, except the vertical banner may contain 「天下一」.
```

アイコン素材:

```text
Single centered icon, no text, no shadow, solid #00ff00 background for chroma key.
```

筆文字素材:

```text
Japanese gold brush calligraphy, exact text only, solid #00ff00 background, no extra letters, no decorative UI.
```

---

## ブラウザ確認必須

実装時は必ずブラウザで確認すること。

想定コマンド例:

```bash
python3 -m http.server 8000
```

またはリポジトリの既存手順があればそれに従う。

確認対象URL例:

```text
http://localhost:8000/landing/pitch/
```

---

## 検収チェック

実装完了前に、各スライドで以下を確認する。

### A. 参照画像への再現性チェック

- 対応する参照画像と同じ情報設計になっているか
- 背景の城・垂れ幕・青い夜の雰囲気が再現できているか
- 金色の筆文字・金色装飾が近い印象になっているか
- カード配置・見出し位置・下部コールアウトが近いか
- 全体の密度が参照画像に近いか
- 右上/右背景の余白が不自然に空いていないか
- スライド番号・タイトルの位置が揃っているか

### B. スライドデザイン品質チェック

- 16:9画面内にすべて収まっているか
- 文字がカードや枠からはみ出していないか
- 行間が詰まりすぎていないか
- 無駄な余白が多すぎないか
- 文字が小さすぎないか
- 背景に対して文字コントラストが十分か
- 重要な見出しが一目で読めるか
- カード同士の高さ・余白・整列が揃っているか
- 下部コールアウトが潰れていないか
- slide 04 のアニメーションが機能しているか
- スコアボードの数値更新・順位更新・インシデント表示が見えるか

### C. 完成扱いしてはいけない状態

以下が1つでもある場合は完成扱いしない。

- テキストが枠からはみ出している
- スライド下部が切れている
- 参照画像に比べて明らかに情報密度が低い
- 大見出しが小さく、迫力がない
- 背景だけ派手で、本文が読みづらい
- 余白が不自然に大きい
- 3カラム/4カラムの高さが揃っていない
- slide 04 のアニメーションが消えている
- スマホ用CSSが原因でPC表示の16:9が崩れている
- 「できた」と言っているが、ブラウザで確認していない

---

## 実装ステップ

### Step 1: ファイル整理

- 現行 `index.html` の内容とスライド構成を維持する
- CSSを `styles/pitch-theme.css` に分離する
- JSを `scripts/pitch.js` に分離する
- 表示が壊れていないことを確認する

### Step 2: 共通デザインシステム作成

- dark navy / electric blue / gold の共通変数を作る
- `.slide-shell`
- `.tc-panel`
- `.tc-callout`
- `.tc-section-label`
- `.tc-brush`
- `.tc-grid-*`
- `.tc-scoreboard`
を作る

### Step 3: slide 01 再現

- slide 01 を最初に完成度高く再現する
- ここで全体の共通ルールを固める
- ブラウザで参照画像と比較する

### Step 4: slide 02〜03 再現

- slide 02 の5改善カードを実装
- slide 03 の4ステップカードを実装
- 文字はHTMLで保持

### Step 5: slide 04 再現

- JSアニメーションは維持
- UIを参照画像に近づける
- ブラウザで実際に動かして確認する

### Step 6: slide 05〜09 再現

- 共通コンポーネントを使って順に作る
- QRコードやリンクカードは必要に応じて調整

### Step 7: 最終調整

- 16:9で全スライド確認
- 文字はみ出し確認
- 余白確認
- コントラスト確認
- slide 04 アニメーション確認
- GitHub Pages相対パス確認

---

## 完了条件

以下を満たして初めて完了とする。

1. `landing/pitch/index.html` をブラウザで開き、9枚すべて確認済み
2. 各スライドが対応する参照画像に十分近い
3. スライドデザインとして破綻していない
4. 文字がはみ出していない
5. 16:9で全要素が収まっている
6. slide 04 の既存アニメーションが維持されている
7. コードがGitHub Pagesで動く相対パスになっている
8. 参照画像・素材・CSS・JSが整理されたディレクトリに保存されている

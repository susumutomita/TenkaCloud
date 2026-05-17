# @TenkaCloud/landing-page

TenkaCloud の OSS ランディングページ。 主催者向けの製品紹介 + Google Form ウェイトリスト埋め込み + Participant Portal / Admin Console / GitHub への deep link。

## ローカル開発

```bash
cd apps/landing-page
bun run dev
# → http://localhost:5176
```

並走ポート: admin-console 5173 / application-admin-console 5174 / participant-portal 5175 / landing-page **5176**。

## Google Form を差し替える

waitlist 用 Google Form の embed URL を 2 通りで注入できる。

### dev (= ローカル)

```bash
# apps/landing-page/.env.local
VITE_WAITLIST_FORM_URL=https://docs.google.com/forms/d/e/<FORM_ID>/viewform?embedded=true
```

### production (= CloudFront 配信)

`runtime-config.json` を CloudFront 配下に配置し、 `waitlistFormUrl` を設定する。 同じ仕組みで Participant Portal / Admin Console の URL も差し替える。

```json
{
  "waitlistFormUrl": "https://docs.google.com/forms/d/e/FORM_ID/viewform?embedded=true",
  "participantPortalUrl": "https://portal.example.com",
  "adminConsoleUrl": "https://admin.example.com",
  "githubRepoUrl": "https://github.com/<owner>/TenkaCloud"
}
```

未設定なら waitlist セクションは「Google Form 未設定」の Alert を出して動作する。

## デザイン方針

- **Cloudscape 一択** — 他 SPA (admin-console / application-admin-console / participant-portal) と同じデザイン言語で揃える
- **single page** — `<a href="#waitlist">` 内部リンク。 react-router は使わない (= overkill)
- **runtime-config.json で差し替え** — `apps/*/dist/` は static asset、 環境差分は runtime に注入する (`INVARIANT_APP_CODE_IS_UNMODIFIED`)

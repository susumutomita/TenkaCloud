import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { applicationConsoleCopy } from "../src/components/ProductLoginShell";
import { _testInternals, I18nProvider, useT } from "../src/i18n";

function CreationCopy() {
  const t = useT();
  return (
    <>
      <p>{t("event_create.login_keys_body")}</p>
      {[0, 1, 2].map((count) => (
        <p key={count}>{t("event_create.selection_summary", { problems: count, teams: count })}</p>
      ))}
    </>
  );
}

it.each([
  [
    "en",
    "This is the only time the team login keys are shown. Store and distribute them securely before you leave this dialog.",
    "Problems: 1 · Teams: 1",
    "Problems: 0 · Teams: 0",
    "Problems: 2 · Teams: 2",
  ],
  [
    "ja",
    "チームのログインキーを表示するのはこの画面だけです。画面を閉じる前に安全な場所へ保存し、各チームへ安全に配布してください。",
    "問題 1 件 · チーム 1 件",
    "問題 0 件 · チーム 0 件",
    "問題 2 件 · チーム 2 件",
  ],
])("creation copy uses plain language in %s", (locale, body, one, zero, two) => {
  localStorage.setItem("tenkacloud.application-admin.locale", locale);
  render(
    <I18nProvider>
      <CreationCopy />
    </I18nProvider>,
  );
  for (const text of [body, one, zero, two]) expect(screen.getByText(text)).toBeInTheDocument();
});

it.each(["en", "ja"] as const)("has no raw login-key field names in %s product copy", (locale) => {
  expect(JSON.stringify(_testInternals.LOCALE_DICTIONARIES[locale])).not.toMatch(/teamLoginKey/u);
});

it.each([
  ["en", "Cloud hosting", "TENKACLOUD · CLOUD HOSTING", "Run your competition, "],
  ["ja", "クラウド開催", "TENKACLOUD · クラウド開催", "あなたの競技を、"],
] as const)("retains cloud copy in %s", (locale, planeLabel, eyebrow, headlineLead) => {
  const dict = _testInternals.LOCALE_DICTIONARIES[locale];
  const t = (key: string) => _testInternals.resolveKey(dict, key) ?? key;
  expect(applicationConsoleCopy(t, "title", "subtitle")).toMatchObject({
    planeLabel,
    eyebrow,
    headlineLead,
  });
});

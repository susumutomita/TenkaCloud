import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EN_UI } from "../../landing/cloud-master/locales/en-ui.js";

const read = (path: string) =>
  readFileSync(new URL(`../../landing/${path}`, import.meta.url), "utf8");
const html = read("cloud-master/index.html");
const property = "G-6WQ914PCKT";
const bootstrap = read("cloud-master/analytics.js");

test("Cloud Master loads the existing LP destination once with a locale-ready standard page title", () => {
  const url = `https://www.googletagmanager.com/gtag/js?id=${property}`;
  expect(read("index.html")).toContain(url);
  expect(read("index.en.html")).toContain(url);
  expect(html.match(/https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=/g)).toHaveLength(1);
  expect(html.match(/src="\.\/analytics\.js\?v=/g)).toHaveLength(1);
  expect(html).toContain(`<script async src="${url}">`);
  expect(bootstrap).toContain('window.gtag("config", "G-6WQ914PCKT"');
  expect(bootstrap).toContain('page_title: tr("APIの番人。 | 目指せクラウドマスター")');
  expect(bootstrap).toContain("page_location: location.href");
  expect(bootstrap).toContain("send_page_view: false");
  expect(
    [...bootstrap.matchAll(/window\.gtag\("event", "([^"]+)"/g)].map((match) => match[1]),
  ).toEqual(["page_view"]);
  expect(bootstrap.match(/window\.gtag\("config"/g)).toHaveLength(1);
});

test("analytics does not add custom game events or override consent and opt-out controls", () => {
  expect(html).toContain("window.dataLayer = window.dataLayer || []");
  expect(html).toContain("dataLayer.push(arguments)");
  expect(html).toContain("window.gtag = window.gtag ||");
  expect(bootstrap).not.toMatch(/user_id|user_properties|consent|ga-disable/);
  for (const path of ["game.js", "engine.js", "share.js"])
    expect(read(`cloud-master/${path}`)).not.toMatch(
      /gtag|dataLayer|google-analytics|googletagmanager/,
    );
});

test("Japanese and English disclosures acknowledge automatic analytics and retain the AWS boundary", () => {
  expect(html).not.toContain("追跡・AWSへの通信なし");
  expect(html).toContain("ゲームは実際のAWS操作を実行しません。");
  const notice = html.match(/<p class="analytics-note">([^<]+)</)?.[1].trim();
  if (!notice) throw new Error("Missing analytics disclosure");
  expect(notice).toContain("Google LLC");
  expect(notice).toContain("自動計測");
  expect(EN_UI[notice]).toContain("automatic interaction measurements");
  expect(EN_UI[notice]).toContain("No custom game-answer or score events");
  expect(html).toContain('id="privacy-link" href="../privacy.html"');
  expect(read("cloud-master/game.js")).toContain(
    'locale === "en" ? "../privacy.en.html" : "../privacy.html"',
  );
  for (const path of ["privacy.html", "privacy.en.html"]) {
    const policy = read(path);
    expect(policy).toContain("Cloud Master");
    expect(policy).toContain("Google LLC");
    expect(policy).toContain("Cookie");
  }
  expect(read("privacy.html")).toContain("ユーザー提供データの自動検出設定");
  expect(read("privacy.en.html")).toContain("Automatic user-provided-data detection");
});

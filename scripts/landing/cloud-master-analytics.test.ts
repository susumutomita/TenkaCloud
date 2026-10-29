import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EN_UI } from "../../landing/cloud-master/locales/en-ui.js";

const read = (path: string) =>
  readFileSync(new URL(`../../landing/${path}`, import.meta.url), "utf8");
const html = read("cloud-master/index.html");
const property = "G-6WQ914PCKT";
const tag = (source: string) =>
  source.match(/<!-- Google tag \(gtag\.js\) -->[\s\S]*?<\/script>\s*<script>([\s\S]*?)<\/script>/);

test("Cloud Master uses the unchanged top-LP Google tag exactly once", () => {
  expect(tag(html)?.[0]).toBe(tag(read("index.html"))?.[0]);
  expect(tag(read("index.en.html"))?.[0]).toBe(tag(html)?.[0]);
  expect(html.match(/https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=/g)).toHaveLength(1);
  expect(html.match(/gtag\('config'/g)).toHaveLength(1);
  expect(html).toContain(
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${property}">`,
  );
});

test("analytics does not add custom game events or override consent and opt-out controls", () => {
  const bootstrap = tag(html)?.[1] ?? "";
  expect(bootstrap).toContain("window.dataLayer = window.dataLayer || []");
  expect(bootstrap).not.toMatch(/user_id|user_properties|gtag\(['"]event|consent|ga-disable/);
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

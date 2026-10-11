/** Real built UI/export/print rehearsal with an explicitly synthetic event response.
 * Runtime source/result wiring is tested separately by cloud-play and uptime-host.
 * Uses an ephemeral host and existing Chrome; no AWS, persistent credentials or deployment.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { chromium } from "playwright-core";

import { spawnPrivateKeyProcess } from "../private-key-process";
import { fillOrganizerKey, signInOrganizer } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = process.env.HOST_E2E_ARTIFACT_DIR ?? join(root, ".cache/skill-evidence-review");
mkdirSync(output, { recursive: true });
const handle = spawnPrivateKeyProcess(
  [process.execPath, "run", "scripts/local-host/tests/e2e-host.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      HOST_E2E_KEY_FD: "3",
      HOST_E2E_ADMIN_PORT: "0",
      HOST_E2E_PARTICIPANT_PORT: "0",
    },
  },
);
handle.stderr.resume();
function line(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    lines.once("line", resolve);
    lines.once("error", reject);
  });
}
const [publicLine, key] = await Promise.all([line(handle.stdout), line(handle.privateOutput)]);
const host = { ...(JSON.parse(publicLine) as { admin: string }), key };
const browser = await chromium.launch({
  executablePath:
    process.env.HOST_E2E_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "en-US" });
  await signInOrganizer(page, host);
  const fixtureModulePath = "../../../apps/application-admin-console/test/fixtures/skill-evidence";
  const fixtureModule = (await import(fixtureModulePath)) as {
    evidenceFixture: () => { eventId: string };
  };
  const detail = fixtureModule.evidenceFixture();
  await page.route(`**/api/events/${detail.eventId}?*`, (route) => route.fulfill({ json: detail }));
  for (const locale of ["en", "ja"] as const) {
    await page.evaluate(
      (value) => localStorage.setItem("tenkacloud.application-admin.locale", value),
      locale,
    );
    await page.goto(`${host.admin}/events/${detail.eventId}/report`);
    await fillOrganizerKey(page, host.key);
    await page.locator("button[type=submit]").click();
    const title = locale === "en" ? "Team Skill Evidence" : "チーム単位の Skill Evidence";
    const section = page.getByRole("region", { name: title });
    await section.waitFor().catch(async () => {
      await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
      console.error("Report section unavailable after organizer sign-in");
      throw new Error("Skill section not visible");
    });
    const expected = await section.innerText();
    assert(expected.includes("aws.parameter.read"));
    assert(expected.includes("service.endpoint.probe"));
    assert(expected.includes(locale === "en" ? "Demonstrated" : "観測により実証"));
    assert(expected.includes(locale === "en" ? "Not observed" : "成功未観測"));
    await section.screenshot({ path: join(output, `${locale}-ui.png`) });
    for (const extension of ["html", "md"] as const) {
      const waiting = page.waitForEvent("download");
      await page.getByTestId(`event-report-download-${extension}`).click();
      const download = await waiting;
      const path = join(output, `${locale}-report.${extension}`);
      await download.saveAs(path);
      const text = readFileSync(path, "utf8");
      const exported = await browser.newPage();
      await exported.setContent(extension === "html" ? text : await marked.parse(text));
      const actual = await exported.getByRole("heading", { name: title }).locator("..").innerText();
      if (extension === "html")
        assert.equal(actual.replace(/\s+/gu, " ").trim(), expected.replace(/\s+/gu, " ").trim());
      else
        for (const value of [
          "aws.parameter.read",
          "service.endpoint.probe",
          "hello-world-alpha",
          "hello-world-battle-alpha",
        ])
          assert(actual.includes(value));
      if (extension === "html")
        await exported.screenshot({ path: join(output, `${locale}-html.png`), fullPage: true });
      await exported.close();
    }
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.getByTestId("event-report-print-button").isVisible(), false);
    assert.equal(await section.innerText(), expected);
    await page.pdf({
      path: join(output, `${locale}-print.pdf`),
      format: "A4",
      printBackground: true,
    });
    await page.screenshot({ path: join(output, `${locale}-print.png`), fullPage: true });
    await page.emulateMedia({ media: "screen" });
  }
  console.log(
    "Skill Evidence browser rehearsal passed: ja/en UI, HTML, rendered Markdown and print PDF. Synthetic API event; no AWS rehearsal.",
  );
} finally {
  await browser.close();
  handle.child.kill("SIGTERM");
  await handle.exited;
}

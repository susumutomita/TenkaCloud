/** Production organizer and Portal rehearsal. Build with `bun run build:host` first. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { forensicRoot, required } from "./forensic-fixture";
import { forensicProcessFixture } from "./forensic-process-fixture";
import { type ForensicProjection, publicIdentityAnswer } from "./forensic-public-evidence";
import { signInOrganizer } from "./organizer-login";

const timeout = 90_000;
const artifacts = join(forensicRoot, ".tenkacloud/host-ui-review");
type Fixture = Awaited<ReturnType<typeof forensicProcessFixture>>;

async function createEvent(page: Page): Promise<Map<string, string>> {
  await page.getByRole("button", { name: "Create event" }).first().click();
  await page.getByLabel("Event name").fill("Evidence investigation rehearsal");
  await page.getByLabel("Team count").fill("2");
  await page
    .getByTestId("problem-select")
    .getByRole("checkbox", { name: /Forensic Casebook/u })
    .check();
  await page.getByRole("button", { name: "Create Event", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByText("Save these login keys now").waitFor();
  const keys = new Map<string, string>();
  for (const slug of ["team-1", "team-2"]) {
    const key = await modal
      .getByRole("row")
      .filter({ hasText: slug })
      .locator("td")
      .nth(1)
      .innerText();
    assert.match(key.trim(), /^[A-Za-z0-9_-]{43}$/u);
    keys.set(slug, key.trim());
  }
  await page.getByTestId("deploy-prompt-now").click();
  await page.waitForURL(/\/events\/[0-9A-Z]{26}$/u);
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Start now" }).click();
  await page.getByText("Scoring", { exact: true }).first().waitFor();
  return keys;
}

async function openCasebook(page: Page, fixture: Fixture, teamKey: string) {
  await page.goto(`${fixture.host.participant.origin}/login#invite=${encodeURIComponent(teamKey)}`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${fixture.host.participant.origin}/problems`);
  await page
    .getByText(/Forensic Casebook/u)
    .first()
    .click();
  await page.getByTestId("case-identity").waitFor();
  await page.getByTestId("case-identity").click();
  assert.equal(await page.getByRole("button", { name: /reset/iu }).count(), 0);
}

async function screenshot(page: Page, filename: string, secrets: readonly string[]) {
  const visible = await page.locator("body").innerText();
  assert.ok(
    secrets.every((secret) => !visible.includes(secret)),
    "Screenshots exclude login keys.",
  );
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.ok(!new URL(page.url()).hash.includes("invite="));
  await page.screenshot({ path: join(artifacts, filename), fullPage: true });
}

async function assertOfficialScores(page: Page, fixture: Fixture, points: number, history: number) {
  await page.goto(`${fixture.host.participant.origin}/scoreboard`);
  await page
    .getByRole("row")
    .filter({ hasText: "team-1" })
    .getByText(`${points} pt`, { exact: true })
    .waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "team-2" })
    .getByText("0 pt", { exact: true })
    .waitFor();
  await page.goto(`${fixture.host.participant.origin}/score-events`);
  await page.getByRole("heading", { name: `History (${history})`, exact: true }).waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "forensic-casebook" })
    .getByText(`+${points} pt`, { exact: true })
    .waitFor();
}

async function main() {
  mkdirSync(artifacts, { recursive: true });
  const fixture = await forensicProcessFixture();
  let browser: Browser | undefined;
  try {
    const executablePath =
      process.env.HOST_E2E_CHROMIUM ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ executablePath });
    const organizerContext = await browser.newContext({ locale: "en-US" });
    organizerContext.setDefaultTimeout(timeout);
    const organizer = await organizerContext.newPage();
    const pageErrors: string[] = [];
    organizer.on("pageerror", (error) => pageErrors.push(error.message));
    await signInOrganizer(organizer, { admin: fixture.host.admin.origin, key: fixture.key });
    const keys = await createEvent(organizer);
    await screenshot(organizer, "forensic-organizer-started.png", [fixture.key, ...keys.values()]);
    const contexts = await Promise.all([
      browser.newContext({ locale: "en-US" }),
      browser.newContext({ locale: "en-US" }),
    ]);
    for (const context of contexts) context.setDefaultTimeout(timeout);
    const alpha = await required(contexts[0]).newPage();
    const beta = await required(contexts[1]).newPage();
    for (const page of [alpha, beta])
      page.on("pageerror", (error) => pageErrors.push(error.message));
    await openCasebook(alpha, fixture, required(keys.get("team-1")));
    await openCasebook(beta, fixture, required(keys.get("team-2")));
    // Complete the participant-visible evidence route without importing a private answer module.
    const { points, history } = await solveVisibleIdentity(alpha);
    await screenshot(alpha, "forensic-evidence-explanation.png", [fixture.key, ...keys.values()]);
    await exploreCase(alpha, "timeline", "order");
    await screenshot(alpha, "forensic-timeline-hints.png", [fixture.key, ...keys.values()]);
    await exploreCase(alpha, "recovery", "trust");
    await screenshot(alpha, "forensic-recovery-hints.png", [fixture.key, ...keys.values()]);
    assert.equal(
      await beta.getByTestId("explanation-account").count(),
      0,
      "A second team cannot see Alpha's solved explanation.",
    );
    await assertOfficialScores(alpha, fixture, points, history);
    await screenshot(alpha, "forensic-official-history.png", [fixture.key, ...keys.values()]);
    await alpha.goto(`${fixture.host.participant.origin}/scoreboard`);
    await screenshot(alpha, "forensic-official-ranking.png", [fixture.key, ...keys.values()]);
    await fixture.restart();
    await openCasebook(alpha, fixture, required(keys.get("team-1")));
    await alpha.getByTestId("explanation-account").waitFor();
    for (const [caseId, questionId] of [
      ["timeline", "order"],
      ["recovery", "trust"],
    ]) {
      await alpha.getByTestId(`case-${caseId}`).click();
      await alpha.getByTestId(`hints-${questionId}`).waitFor();
      assert.equal(
        await alpha.getByTestId(`hints-${questionId}`).locator("li").count(),
        3,
        "Unlocked hints survive a fresh host process.",
      );
      assert.equal(await alpha.getByTestId(`hint-${questionId}`).count(), 0);
    }
    await assertOfficialScores(alpha, fixture, points, history);
    await openCasebook(beta, fixture, required(keys.get("team-2")));
    assert.equal(await beta.getByTestId("explanation-account").count(), 0);
    assert.deepEqual(pageErrors, []);
    console.log(
      "PASS Forensic Casebook: organizer create/deploy/start, two real Portal sessions, public evidence, wrong/correct cited answers, explanation, official ranking/history and durable host restart.",
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

async function solveVisibleIdentity(page: Page): Promise<{ points: number; history: number }> {
  const records = new Map<string, string>();
  for (const id of ["I-IDP", "I-CLOUD"]) {
    await page.getByTestId(`evidence-${id}`).click();
    const content = required(await page.getByTestId("evidence-content").textContent());
    assert.ok(content.includes('"synthetic": true'));
    records.set(id, content);
    const download = page.locator('[data-testid="download-evidence"][href^="blob:"]');
    await download.waitFor();
    assert.ok(await download.getAttribute("download"), "Evidence is downloadable by filename.");
    const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
    const bytes = readFileSync(required(await file.path()));
    assert.equal(
      bytes.toString("utf8"),
      content,
      "Downloaded evidence matches the visible record byte for byte.",
    );
    assert.ok(
      (await page.getByTestId("evidence-sha256").innerText()).includes(
        createHash("sha256").update(bytes).digest("hex"),
      ),
    );
  }
  const answer = publicIdentityAnswer(
    required(records.get("I-IDP")),
    required(records.get("I-CLOUD")),
  );
  for (const id of ["I-IDP", "I-CLOUD"]) await page.getByTestId(`cite-account-${id}`).check();
  await page.getByTestId("answer-account").fill("unrelated-account@aster.example");
  const wrong = await submitVisibleAnswer(page);
  assert.equal(wrong.lastResult?.status, "incorrect");
  assert.equal(wrong.score, 0);
  await page.getByTestId("result-account").waitFor();
  assert.equal(await page.getByTestId("explanation-account").count(), 0);
  await page.getByTestId("answer-account").fill(answer);
  const correct = await submitVisibleAnswer(page);
  assert.equal(correct.lastResult?.status, "correct");
  assert.equal(correct.score, 20);
  await page.getByTestId("explanation-account").waitFor();
  assert.match(await page.getByTestId("explanation-account").innerText(), /session|account/iu);
  return { points: correct.score, history: 1 };
}

async function exploreCase(page: Page, caseId: string, questionId: string) {
  await page.getByTestId(`case-${caseId}`).click();
  await page.getByTestId(`question-${questionId}`).waitFor();
  const evidenceButton = page.locator('button[data-testid^="evidence-"]').first();
  await evidenceButton.click();
  assert.ok((await page.getByTestId("evidence-content").innerText()).includes('"synthetic": true'));
  for (let rung = 1; rung <= 3; rung++) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/portal/me/coordination/op") &&
          response.request().method() === "POST",
      ),
      page.getByTestId(`hint-${questionId}`).click(),
    ]);
    assert.equal(response.status(), 200);
    const projection = ((await response.json()) as { projection: ForensicProjection }).projection;
    const question = required(
      projection.cases
        .find((item) => item.id === caseId)
        ?.questions.find((item) => item.id === questionId),
    );
    assert.equal(question.unlockedHints, rung);
    assert.equal(projection.score, 20, "Hints do not change the official answer award.");
    for (const hint of question.hints) {
      await page
        .getByTestId(`question-${questionId}`)
        .getByText(hint.en, { exact: true })
        .waitFor();
    }
  }
}

async function submitVisibleAnswer(page: Page): Promise<ForensicProjection> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/portal/me/coordination/op") &&
        response.request().method() === "POST",
    ),
    page.getByTestId("submit-account").click(),
  ]);
  assert.equal(response.status(), 200);
  return ((await response.json()) as { projection: ForensicProjection }).projection;
}

if (import.meta.main)
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config";
import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import {
  buildDisruptionLog,
  buildProblemBreakdown,
  buildScoreboard,
  summarizeEvent,
} from "../../src/lib/event-report-stats";
import { buildExportView } from "../../src/pages/event-report/export-view";
import { buildEventReportHtml } from "../../src/pages/event-report/exporters/html";
import { buildEventReportMarkdown } from "../../src/pages/event-report/exporters/markdown";
import { SkillEvidenceSection } from "../../src/pages/event-report/skill-section";
import { evidenceFixture } from "../fixtures/skill-evidence";

const config: AppConfig = {
  tenantName: "rehearsal",
  tenantId: "local",
  apiBaseUrl: "",
  cognitoDomain: "",
  cognitoClientId: "",
  redirectUri: "",
  scope: "",
  samlIdpDirectory: {},
};

describe("skill evidence output parity", () => {
  for (const locale of ["ja", "en"] as const) {
    it(`${locale}: renders the same team evidence and missing-data reasons in UI / HTML / Markdown / printable DOM`, () => {
      const detail = evidenceFixture();
      const strings = locale === "ja" ? ja : en;
      const t = (key: string) =>
        (strings.event_report as Record<string, string>)[key.split(".")[1] ?? ""] ?? key;
      const exp = buildExportView({
        detail,
        locale,
        t,
        config,
        coverNote: "",
        generatedAt: "2026-10-01",
        summary: summarizeEvent(detail),
        scoreboard: buildScoreboard(detail.teams, detail.scoreEventsByTeam),
        breakdown: buildProblemBreakdown(detail),
        disruptions: buildDisruptionLog(detail),
      });
      const view = exp.skills;
      if (!view) throw new Error("skill view missing");
      const rendered = render(
        <div data-tenkacloud-print-root="true">
          <SkillEvidenceSection view={view} />
        </div>,
      );
      const html = buildEventReportHtml(exp);
      const md = buildEventReportMarkdown(exp);
      expect(screen.getByRole("heading", { name: t("event_report.skill_title") })).toBeTruthy();
      for (const row of view.rows)
        for (const cell of row) {
          expect(rendered.container.textContent).toContain(cell);
          expect(html).toContain(cell);
          expect(md).toContain(cell.replace(/_/gu, "&#95;"));
        }
      expect(
        rendered.container.querySelector('[data-tenkacloud-print-root="true"] section'),
      ).toBeTruthy();
      rendered.unmount();
    });
  }
  it("escapes untrusted labels and omits answer/hint/key fields", () => {
    const detail = evidenceFixture();
    const view = {
      title: "Evidence",
      note: "Team only",
      headers: ["Team", "Skill", "State", "Evidence"],
      rows: [
        [
          "alpha",
          "<script>alert(1)</script> [link](javascript:alert(1))",
          "demonstrated",
          "job: safe",
        ],
      ],
    };
    const exp = { skills: view };
    // Full envelope from the same builder keeps exporter regression sections intact.
    const full = buildExportView({
      detail,
      locale: "ja",
      t: (key) => key,
      config,
      coverNote: "",
      generatedAt: "",
      summary: summarizeEvent(detail),
      scoreboard: [],
      breakdown: [],
      disruptions: [],
    });
    Object.assign(full, exp);
    expect(buildEventReportHtml(full)).not.toContain("<script>");
    expect(buildEventReportMarkdown(full)).toContain("&lt;script&gt;");
    expect(buildEventReportMarkdown(full)).toContain("&#91;link&#93;");
    const serialized = JSON.stringify(full.skills);
    for (const field of ["teamLoginKey", "flagOutputKey", "hintId", "answer", "hiddenChecks"])
      expect(serialized).not.toContain(field);
  });
});

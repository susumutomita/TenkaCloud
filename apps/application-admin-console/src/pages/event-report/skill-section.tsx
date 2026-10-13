import type { Translate } from "./export-view";
import type { SkillEvidenceView } from "./skill-view";

/**
 * Rows the page renders. A maximum event (99 teams x 50 problems x 16 declarations) has 79,200;
 * the HTML and Markdown downloads keep every row.
 */
export const SKILL_EVIDENCE_RENDER_LIMIT = 500;

export function SkillEvidenceSection({
  view,
  t,
}: {
  readonly view: SkillEvidenceView;
  readonly t: Translate;
}) {
  const rows = view.rows.slice(0, SKILL_EVIDENCE_RENDER_LIMIT);
  return (
    <section aria-label={view.title} data-tenkacloud-print-section="true">
      <h2>{view.title}</h2>
      <p>{view.note}</p>
      {rows.length < view.rows.length && (
        <p>
          {t("event_report.skill_render_limit", { shown: rows.length, total: view.rows.length })}
        </p>
      )}
      <table data-tenkacloud-print-table="true" style={{ width: "100%", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "12%" }} />
          <col style={{ width: "23%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "45%" }} />
        </colgroup>
        <thead>
          <tr>
            {view.headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join(";")}>
              {row.map((cell, column) => (
                <td key={view.headers[column]} style={{ overflowWrap: "anywhere" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

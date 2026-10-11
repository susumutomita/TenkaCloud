import type { SkillEvidenceView } from "./skill-view";

export function SkillEvidenceSection({ view }: { readonly view: SkillEvidenceView }) {
  return (
    <section aria-label={view.title} data-tenkacloud-print-section="true">
      <h2>{view.title}</h2>
      <p>{view.note}</p>
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
          {view.rows.map((row) => (
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

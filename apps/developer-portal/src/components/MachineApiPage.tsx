import { listMachineApiOperations } from "@/content/machine-api.generated";
import { MACHINE_API_COPY } from "@/content/machine-api-copy";
import type { Locale } from "@/lib/i18n";
import { MachineApiReference } from "./MachineApiReference";

/**
 * Issue #2950: `/developers/api/machine/` (ja) と `/en/developers/api/machine/` (en) の本体。
 *
 * operation の表は静的に描画する。Scalar は client component なので、pre-render された HTML に
 * operation 名が残るのは表のほうであり、検索と静的生成の test が見ているのもそこである。
 */
export function MachineApiPage({ locale }: { locale: Locale }) {
  const copy = MACHINE_API_COPY[locale];
  const operations = listMachineApiOperations();

  return (
    <div className="page">
      <h1>{copy.heading}</h1>
      <p>{copy.lead}</p>

      <h2>{copy.tryItHeading}</h2>
      <p>{copy.tryItBody}</p>

      <h2>{copy.reachHeading}</h2>
      <p>{copy.reachBody}</p>

      <h2>{copy.credentialHeading}</h2>
      <p>{copy.credentialBody}</p>

      <h2>{copy.tableHeading}</h2>
      <table>
        <thead>
          <tr>
            <th>{copy.tableColumns.operation}</th>
            <th>{copy.tableColumns.capability}</th>
            <th>{copy.tableColumns.scope}</th>
            <th>{copy.tableColumns.summary}</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((operation) => (
            <tr key={operation.operationId} id={operation.operationId}>
              <td>
                <code>
                  {operation.method} {operation.path}
                </code>
              </td>
              <td>{operation.capability}</td>
              <td>
                <code>{operation.scope}</code>
              </td>
              <td>{operation.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <MachineApiReference />
    </div>
  );
}

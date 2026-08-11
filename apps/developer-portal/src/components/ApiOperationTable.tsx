import { type Capability, listApiOperations } from "@/content/openapi";

const CAPABILITY_LABEL: Record<Capability, string> = {
  "browse-only": "Browse only",
  "sandbox-safe": "Sandbox safe",
  "authenticated-write": "Authenticated write",
};

// A statically rendered operation list. It complements the interactive Scalar
// renderer so the API operation names are present in the pre-rendered HTML (which
// is what the static-generation and search tests assert) and so the reference is
// readable even before client hydration. Every row shows the capability label from
// the OpenAPI artifact, but no credentials.
export function ApiOperationTable() {
  const operations = listApiOperations();
  return (
    <table>
      <caption>Platform API operations (browse-only reference)</caption>
      <thead>
        <tr>
          <th>Operation</th>
          <th>Method</th>
          <th>Path</th>
          <th>Capability</th>
        </tr>
      </thead>
      <tbody>
        {operations.map((op) => (
          <tr key={op.operationId} id={op.operationId}>
            <td>{op.operationId}</td>
            <td>{op.method}</td>
            <td>
              <code>{op.path}</code>
            </td>
            <td>{CAPABILITY_LABEL[op.capability]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

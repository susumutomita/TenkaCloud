// [Issue #2103] Reference-table renderers. Every table below renders the GENERATED
// `REFERENCE_DATA` (apps/developer-portal/src/content/reference-data.ts), which the
// generator derives from the real pack/problem schemas, runtime capability
// declarations, the pack CLI usage strings, and the validator error-code registry.
// The MDX reference pages embed these so the normative facts have one source of
// truth in code/schema and cannot be hand-edited out of sync.
import { REFERENCE_DATA } from "@/content/reference-data";
import { MaturityBadge } from "./MaturityBadge";

function requiredLabel(required: boolean): string {
  return required ? "Required" : "Optional";
}

export function ManifestFieldTable() {
  return (
    <table className="reference-table" data-reference="manifest-fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Presence</th>
          <th>Constraint</th>
        </tr>
      </thead>
      <tbody>
        {REFERENCE_DATA.manifestFields.map((field) => (
          <tr key={field.name}>
            <td>
              <code>{field.name}</code>
            </td>
            <td>
              <code>{field.type}</code>
            </td>
            <td>{requiredLabel(field.required)}</td>
            <td>{field.constraint}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MetadataFieldTable() {
  return (
    <table className="reference-table" data-reference="metadata-fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Presence</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {REFERENCE_DATA.metadataFields.map((field) => (
          <tr key={field.name}>
            <td>
              <code>{field.name}</code>
            </td>
            <td>
              <code>{field.type}</code>
            </td>
            <td>{requiredLabel(field.required)}</td>
            <td>{field.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RuntimeMatrixTable() {
  return (
    <table className="reference-table" data-reference="runtime-matrix">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Engine</th>
          <th>Support</th>
          <th>Maturity</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {REFERENCE_DATA.runtimeMatrix.map((row) => (
          <tr key={`${row.provider}/${row.engine}`}>
            <td>
              <code>{row.provider}</code>
            </td>
            <td>
              <code>{row.engine}</code>
            </td>
            <td>{row.support}</td>
            <td>
              <MaturityBadge level={row.maturity} />
            </td>
            <td>{row.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CliCommandTable() {
  return (
    <table className="reference-table" data-reference="cli-commands">
      <thead>
        <tr>
          <th>Command</th>
          <th>Usage</th>
        </tr>
      </thead>
      <tbody>
        {REFERENCE_DATA.cliCommands.map((command) => (
          <tr key={command.name}>
            <td>
              <code>{command.name}</code>
            </td>
            <td>
              <code>{command.usage}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ValidationErrorTable() {
  return (
    <table className="reference-table" data-reference="validation-errors">
      <thead>
        <tr>
          <th>Code</th>
          <th>What it means / how to fix it</th>
        </tr>
      </thead>
      <tbody>
        {REFERENCE_DATA.validationErrors.map((error) => (
          <tr key={error.code}>
            <td>
              <code>{error.code}</code>
            </td>
            <td>{error.explanation}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProvenanceFactList() {
  return (
    <dl className="reference-facts" data-reference="provenance-facts">
      {REFERENCE_DATA.provenanceFacts.map((fact) => (
        <div key={fact.title}>
          <dt>
            {fact.title} <MaturityBadge level={fact.maturity} />
          </dt>
          <dd>{fact.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

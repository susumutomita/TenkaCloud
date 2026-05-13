import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import type { FriendlyError } from "../lib/friendly-error";

/**
 * Issue #665: backend error を人間可読に表示する Alert。
 * title + hint + 原因候補 list を構造化して表示し、 raw JSON は出さない。
 */
export function FriendlyErrorAlert({ error }: { readonly error: FriendlyError }) {
  return (
    <Alert type="error" header={error.title}>
      {error.hint ? <Box variant="p">{error.hint}</Box> : null}
      {error.possibleCauses && error.possibleCauses.length > 0 ? (
        <Box variant="div" padding={{ top: "xs" }}>
          <Box variant="strong">考えられる原因:</Box>
          <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 22 }}>
            {error.possibleCauses.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
        </Box>
      ) : null}
    </Alert>
  );
}

/** Synthetic offline fixture, not a production catalog entry or an attestation mechanism. */
export const repairSource = `export function canRead(owner, sessionUser, requestedUser) {
  return owner === requestedUser;
}
`;
export const repairChecks = `import { canRead } from './exercise.mjs';
const checks = {
  'normal-functionality': canRead('alice', 'alice', 'alice') === true && canRead('bob', 'bob', 'bob') === true,
  security: canRead('alice', 'bob', 'alice') === false && canRead('bob', 'alice', 'bob') === false,
};
console.log(JSON.stringify(checks));
`;
export const repairArtifact = JSON.stringify({
  files: { "exercise.mjs": repairSource, "checks.mjs": repairChecks },
  command: "node checks.mjs",
});

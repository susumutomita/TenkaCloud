# Shared verification receipts

`make verify` runs existing development gates plus host type checks and tests,
then records commands, exit codes, logs and the checkout HEAD in a new temporary
directory outside the repository. Python 3.10+ on Linux/macOS is required alongside
the existing pinned Bun 1.4.4 toolchain. Install locked dependencies with lifecycle scripts
disabled, as required by the repository instructions.

The feature map is `verification.json`. Its paths help discover the relevant
checks; they do not automatically select or skip tests. `make before-commit`
still uses its existing changed-file test selection. Passing this profile does
not replace the full test suite in required CI or validate every product feature.
The adapter adds only its own small contract tests to the existing local/CI gates.

Prepare the explicitly selected catalog for host tests with
`make catalog-download catalog-prepare`; these commands do not run problem code.

## Pinned, offline implementation

`scripts/verification/vendor/verify.py` is the unchanged shared runner from
`typescript-template` commit `b434822e6bd2e80480dc8af610ad3f2a234a35e0`
(PR #127), under its retained MIT license. `upstream.json` records source and
SHA-256. The launcher verifies those bytes before executing them. It downloads
nothing, tracks no mutable branch, installs no package and adds no service.
Update the source commit, bytes, digest and tests together in a reviewed PR.
This initial adoption pins the reviewed candidate, not a published release.

## Honest scope

- A zero exit status belongs to the selected command, not all product behavior.
- Dirty checkout, changed HEAD or changed evidence prevents clean-commit success.
- Missing executables are blocked; command failures and timeouts fail.
- Logs and receipts stay local. Inspect them for sensitive data before sharing.
- The receipt does not authorize merge, deployment, real cloud changes or cleanup
  outside the check's owned fixtures.

`make verify-release` additionally records the event rehearsal as **blocked**
until a reviewed real hosting/VM command is supplied. This is an optional,
explicitly invoked evidence profile. It does not add real AWS/VM execution to
normal PR gates or change the policy that event rehearsals are not merge gates.
No real hosting, VM or external-service run is implied by `make verify`.

For a custom evidence directory, invoke:

```sh
python3 scripts/verification/run.py fast --output /tmp/tenka-check-unique
```

The directory must not exist and must be outside the checkout. Commit the source
candidate and rerun to obtain clean-HEAD evidence. This is a cooperative local
record, not a tamper-resistant attestation. Keep project-specific assertions,
regression tests, import checks and permission boundaries in their existing owners.

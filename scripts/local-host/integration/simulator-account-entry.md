# Explicit external Simulator account entry

This mode connects to existing external Simulators. It does not start or stop
processes, download bundles, or attest actual database/token continuity. Generation
compares an organizer-declared binding only. Live VM acceptance remains unverified.

Use `--simulator-connections /absolute/private/connections.json` instead of any
single/managed Simulator flags. Loopback-only hosting and the existing proxy,
owner, permission and token-file guards still apply. The version 1 file contains
1–32 connections, each with a distinct authority ID, normalized endpoint and token
file reference. Relative references resolve beside the manifest. Token values,
bootstrap flags and unknown fields are rejected. Keep the file owner-only, with
no symbolic or hard links. The file is read once; restart to change configuration.

```json
{
  "version": 1,
  "connections": [
    {
      "authorityId": "alpha",
      "generation": 1,
      "endpoint": "http://127.0.0.1:4566",
      "region": "ap-northeast-1",
      "tokenFile": "alpha.token"
    }
  ]
}
```

The organizer account-list response adds safe `authorities` descriptors containing
only authority ID, generation, region, local account ID and deployment role name.
Register through the existing account API with `simulatorAuthority` containing
`authorityId` and `generation`. The tuple of binding and account ID identifies a
registration. Verify and DELETE retain the existing account-ID path and add both
`authorityId` and `generation` query parameters. Bulk entries accept the same
binding and return it on successful rows. A successful verification applies only
to that exact registration; changes while awaiting verification invalidate it.

Event team input supplies `awsAccountId` and `simulatorAuthority`. The Host requires
the exact verified registration and copies its binding into the existing team
JSON. Existing job/disruption retention and engine routing then preserve it.
Missing selectors are rejected even with one configured connection. There is no
implicit adoption of legacy jobs, default connection, account-based authority
inference or real-AWS fallback. Removing a binding can block retained cleanup;
restore the original compatible explicit binding to clean up those resources.

Legacy single-connection and real-AWS entry retain their unbound account records
and APIs. Existing 12-digit SQLite registration keys remain unchanged. New bound
records use a qualified TEXT key in the same table; no destructive migration or
new registry table is introduced. The Admin selector uses the same qualified key
so two authorities with the same account ID remain distinct.

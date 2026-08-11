# Reference coordination Battle pack

The canonical worked example of the **inter-team coordination** contract:
a Battle problem that ships a pure coordination plugin the platform hosts. Copy it
when authoring a Battle whose teams interact through shared state (routers,
alliances, contested resources) rather than only through their own deployed stack.

## Layout

```
reference-coordination-battle/
├── tenkacloud-pack.json
└── problems/battles/cross-account-capture/
    ├── metadata.json              # opts in via interTeamCoordination.plugin
    ├── template.yaml              # per-team deploy body (empty reference)
    └── coordination/
        └── sector-control.ts      # the coordination plugin (default export)
```

## How coordination is wired

A problem opts in by declaring the plugin path in `metadata.json`:

```json
"interTeamCoordination": {
  "plugin": "coordination/sector-control.ts",
  "name": "Cross-Account Sector Control"
}
```

At synth the platform bundles the plugin into a self-contained ES module; at
runtime the minimal-IAM **coordination dispatcher** Lambda drives it for each op:
read the one shared per-event row → `dispatchOp` (validate → apply) → optimistic
write → `projectForTeam`. The dispatcher holds no cross-account credentials, so a
plugin can never reach competitor accounts. The plugin is a
pure, deterministic reducer — no clock, network, or cloud SDK.

## The example: Cross-Account Capture

Teams race to plant a foothold in a fixed roster of contested cross-account
regions ("sectors"). Each sector is held by at most one team.

| Hook | Behaviour |
| --- | --- |
| `initialState` | Every sector free, capture window `open`. |
| `validateOp` | Rejects claiming a taken sector (`sector_taken`), your own (`already_yours`), an unknown one (`unknown_sector`), or any claim after the window closes (`event_locked`); rejects releasing a sector you do not hold (`not_your_sector`). |
| `applyOp` | Assigns or clears the sector's holder. |
| `tick` | Closes the capture window once the event passes 15 minutes. |
| `projectForTeam` | Returns only your holdings plus anonymous free/taken counts — never which rival holds a sector. |

The plugin is exercised branch-by-branch in
`infrastructure/test/problem-pack/reference-coordination-battle-coordination.test.ts`.

## Wiring boundary

The live dispatcher is fed from the core `problems/` catalog today. This in-repo
pack validates and is unit-tested against the coordination SDK as the reference
consumer; carrying pack-declared coordination all the way through to a running
dispatcher (pack activation) and wiring the scoring engine's per-tick `runTick`
call are tracked as follow-up work in the relevant GitHub issues.

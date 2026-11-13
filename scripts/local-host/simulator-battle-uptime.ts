import { SimulatorBattleProbeJournal } from "./simulator-battle-probe-journal";
import { SimulatorBattleProbeStore } from "./simulator-battle-probe-store";
import { SimulatorBattleRegistrationStore } from "./simulator-battle-registration-store";
import { scoreSettledBattleMinute } from "./simulator-battle-score";

type Context = Parameters<typeof scoreSettledBattleMinute>[0];
type Dependencies = Parameters<typeof scoreSettledBattleMinute>[2];

/** Native owned-session scheduler only. Never resubmit an uncertain key, nor
 * manufacture registration or provider authority from a job/endpoint string. */
export async function runBattleUptimeMinute(
  context: Context,
  minute: number,
  dependencies: Dependencies = {},
) {
  const { host, clock } = context;
  const { target } = context.current();
  const { eventId, teamId } = target.owner;
  if (host.uptimeObserved(eventId, teamId, target.problemId, minute)) return;
  const registrations = new SimulatorBattleRegistrationStore(host, {
    kind: "owned-battle-registration-scope",
    providerDomain: clock.domain,
  });
  const slots = ["frontend", "api"] as const;
  if (slots.some((slot) => !registrations.get(target, slot))) return;
  const store = new SimulatorBattleProbeStore(host, { kind: "owned-battle-probe-journal" });
  const journal = new SimulatorBattleProbeJournal(
    { ...context, store },
    {
      ...dependencies,
      wallNow: context.wallNow,
    },
  );
  if (!(await recoverPriorMinute(store, journal, eventId, teamId, minute))) return;
  let pair = slots.map((slot) => store.forMinute(eventId, teamId, slot, minute));
  if (pair.every((record) => !record)) pair = [...(await journal.prepareMinute(minute, 7900))];
  if (pair.some((record) => !record)) throw new Error("Incomplete durable Battle minute pair.");
  for (const record of pair) {
    if (!record) throw new Error("Missing Battle minute record.");
    if (record.state === "prepared") await journal.start(record.descriptor.key);
    else if (record.state !== "settled") await journal.recover(record.descriptor.key);
  }
  if (slots.some((slot) => store.forMinute(eventId, teamId, slot, minute)?.state !== "settled"))
    return;
  await scoreSettledBattleMinute(context, minute, dependencies);
}

async function recoverPriorMinute(
  store: SimulatorBattleProbeStore,
  journal: SimulatorBattleProbeJournal,
  eventId: string,
  teamId: string,
  minute: number,
): Promise<boolean> {
  const slots = ["frontend", "api"] as const;
  // An unresolved previous minute retains its key and blocks a fresh dispatch.
  for (const slot of slots) {
    const active = store.active(eventId, teamId, slot);
    if (active && active.minute !== minute) {
      if (active.state === "prepared") {
        store.expireUnstarted(active.descriptor.key, active.revision, minute);
        continue;
      }
      const recovered = await journal.recover(active.descriptor.key);
      if (recovered.state !== "settled") return false;
    }
  }
  return true;
}

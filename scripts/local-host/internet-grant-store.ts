import { z } from "zod";
import type { HostStore } from "./store";

const grantSchema = z.object({
  eventId: z.string().min(1),
  problemId: z.string().min(1),
  definitionDigest: z.string().min(1),
  requestIds: z
    .array(z.string().min(1))
    .min(1)
    .max(8)
    .refine(
      (ids) => ids.every((id, index) => index === 0 || (ids[index - 1] ?? "") < id),
      "Request IDs must be unique and sorted.",
    ),
  grantedAt: z.iso.datetime(),
});
export type InternetAccessGrant = Readonly<Omit<z.infer<typeof grantSchema>, "requestIds">> & {
  readonly requestIds: readonly string[];
};

export class InternetGrantStore {
  constructor(private readonly host: HostStore) {
    host.database.exec(`CREATE TABLE IF NOT EXISTS host_internet_grants (
      event_id TEXT NOT NULL REFERENCES host_events(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(event_id, problem_id)
    ) STRICT;`);
  }
  get(eventId: string, problemId: string): InternetAccessGrant | undefined {
    const statement = this.host.database.prepare(
      "SELECT body FROM host_internet_grants WHERE event_id=? AND problem_id=?",
    );
    try {
      const row = statement.get(eventId, problemId);
      if (!row) return undefined;
      const grant = grantSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body));
      if (grant.eventId !== eventId || grant.problemId !== problemId)
        throw new Error("Internet grant ownership changed.");
      return grant;
    } finally {
      statement.finalize?.();
    }
  }
  put(value: InternetAccessGrant): void {
    const grant = grantSchema.parse(value);
    const statement = this.host.database.prepare(
      "INSERT INTO host_internet_grants(event_id,problem_id,body) VALUES(?,?,?) ON CONFLICT(event_id,problem_id) DO UPDATE SET body=excluded.body",
    );
    try {
      statement.run(grant.eventId, grant.problemId, JSON.stringify(grant));
    } finally {
      statement.finalize?.();
    }
  }
  delete(eventId: string, problemId: string): void {
    const statement = this.host.database.prepare(
      "DELETE FROM host_internet_grants WHERE event_id=? AND problem_id=?",
    );
    try {
      statement.run(eventId, problemId);
    } finally {
      statement.finalize?.();
    }
  }
}

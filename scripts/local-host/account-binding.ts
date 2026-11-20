import type { AccountConnection } from "./model";
import {
  authorityBinding,
  authorityUnavailable,
  type SimulatorAuthority,
} from "./simulator-authority";

/** Legacy unbound registrations retain their original 12-digit primary keys. */
export function competitorAccountKey(accountId: string, binding?: SimulatorAuthority): string {
  const valid = authorityBinding(binding);
  return valid ? `sim:${valid.authorityId}:${valid.generation}:${accountId}` : accountId;
}

export function accountConnection(
  connection: AccountConnection,
  value: unknown,
): AccountConnection {
  const binding = authorityBinding(value);
  if (connection.selectAuthority) {
    if (!binding) throw authorityUnavailable();
    return connection.selectAuthority(binding);
  }
  if (binding) throw authorityUnavailable();
  return connection;
}

export function accountRequestBinding(query: URLSearchParams): SimulatorAuthority | undefined {
  const authorityId = query.get("authorityId");
  const generation = query.get("generation");
  if (authorityId === null && generation === null) return undefined;
  if (
    query.getAll("authorityId").length !== 1 ||
    query.getAll("generation").length !== 1 ||
    generation === null ||
    !/^[1-9]\d*$/u.test(generation)
  )
    throw authorityUnavailable();
  return authorityBinding({ authorityId, generation: Number(generation) });
}

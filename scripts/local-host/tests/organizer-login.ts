interface HostAddress {
  admin: string;
  key: string;
}

export async function organizerToken(host: HostAddress): Promise<string> {
  const response = await fetch(`${host.admin}/api/host/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: host.key }),
  });
  const payload: unknown = await response.json();
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    !("idToken" in payload) ||
    typeof payload.idToken !== "string"
  )
    throw new Error(`Organizer sign-in failed with HTTP ${response.status}.`);
  return payload.idToken;
}

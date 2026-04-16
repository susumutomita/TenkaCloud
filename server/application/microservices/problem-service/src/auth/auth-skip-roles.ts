const DEFAULT_AUTH_SKIP_ROLES = ["competitor"] as const;

export function parseAuthSkipRoles(envValue?: string): string[] {
	if (!envValue) {
		return [...DEFAULT_AUTH_SKIP_ROLES];
	}

	const roles = envValue
		.split(",")
		.map((role) => role.trim())
		.filter(Boolean);

	return roles.length > 0 ? roles : [...DEFAULT_AUTH_SKIP_ROLES];
}

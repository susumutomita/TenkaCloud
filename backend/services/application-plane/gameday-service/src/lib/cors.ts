const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:13000',
  'http://localhost:13001',
];

export function getAllowedOrigins(corsOrigin: string | undefined): string[] {
  if (!corsOrigin) {
    return DEFAULT_LOCAL_ORIGINS;
  }

  const origins = corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : DEFAULT_LOCAL_ORIGINS;
}

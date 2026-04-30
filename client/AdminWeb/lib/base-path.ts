export const CONTROL_PLANE_BASE_PATH =
  process.env.NEXT_PUBLIC_BASE_PATH ?? '/control';

function isControlBasePath(path: string): boolean {
  return (
    path === CONTROL_PLANE_BASE_PATH ||
    path.startsWith(`${CONTROL_PLANE_BASE_PATH}/`) ||
    path.startsWith(`${CONTROL_PLANE_BASE_PATH}?`) ||
    path.startsWith(`${CONTROL_PLANE_BASE_PATH}#`)
  );
}

export function withControlBasePath(path: string): string {
  if (!path.startsWith('/')) {
    return `${CONTROL_PLANE_BASE_PATH}/${path}`;
  }

  if (isControlBasePath(path)) {
    return path;
  }

  return `${CONTROL_PLANE_BASE_PATH}${path}`;
}

export function stripControlBasePath(path: string): string {
  if (path === CONTROL_PLANE_BASE_PATH) {
    return '/';
  }

  if (isControlBasePath(path)) {
    const stripped = path.slice(CONTROL_PLANE_BASE_PATH.length);
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  }

  return path;
}

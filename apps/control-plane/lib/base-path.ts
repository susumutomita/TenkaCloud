export const CONTROL_PLANE_BASE_PATH = '/control';

export function withControlBasePath(path: string): string {
  if (!path.startsWith('/')) {
    return `${CONTROL_PLANE_BASE_PATH}/${path}`;
  }

  if (
    path === CONTROL_PLANE_BASE_PATH ||
    path.startsWith(`${CONTROL_PLANE_BASE_PATH}/`)
  ) {
    return path;
  }

  return `${CONTROL_PLANE_BASE_PATH}${path}`;
}

export function stripControlBasePath(path: string): string {
  if (path === CONTROL_PLANE_BASE_PATH) {
    return '/';
  }

  if (path.startsWith(`${CONTROL_PLANE_BASE_PATH}/`)) {
    return path.slice(CONTROL_PLANE_BASE_PATH.length);
  }

  return path;
}
